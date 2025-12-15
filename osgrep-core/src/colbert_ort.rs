use ort::session::{Session, builder::GraphOptimizationLevel};
use ort::value::Value;
use tokenizers::Tokenizer;
use hf_hub::{api::sync::Api, Repo, RepoType};
use std::collections::HashSet;

fn log_native(msg: impl AsRef<str>) {
    // Intentionally no-op: native logging was polluting CLI output.
    // If you need debugging, add structured logging at the JS layer instead.
    let _ = msg.as_ref();
}

// ColBERT special tokens (these get added during fine-tuning)
const QUERY_MARKER: &str = "[Q]";
const DOC_MARKER: &str = "[D]";
const QUERY_MAXLEN: usize = 32;
// This directly caps how much of each chunk the reranker can "see".
// Keep this in sync with chunk sizing; very large values quickly blow up MaxSim cost.
const DOC_MAXLEN: usize = 96;

pub struct ColbertEncoderOrt {
    session: Session,
    tokenizer: Tokenizer,
    hidden_size: usize,
    // Special token IDs
    cls_id: u32,
    sep_id: u32,
    mask_id: u32,
    pad_id: u32,
    query_marker_id: Option<u32>,
    doc_marker_id: Option<u32>,
    // Skip list for MaxSim (punctuation, special tokens to ignore)
    skip_ids: HashSet<u32>,
}

impl ColbertEncoderOrt {
    pub fn load_from_hf(repo_id: &str, hidden_size: usize) -> anyhow::Result<Self> {
        log_native(format!("[ColBERT-ORT] Downloading model from HF hub: {}", repo_id));

        let api = Api::new()?;
        let repo = api.repo(Repo::new(repo_id.to_string(), RepoType::Model));

        // Download model and tokenizer files
        // Try int8 quantized model first for speed, fall back to fp32
        let model_path = repo.get("onnx/model_int8.onnx")
            .or_else(|_| repo.get("onnx/model.onnx"))?;
        let tokenizer_path = repo.get("tokenizer.json")?;

        // Try to load skiplist
        let skip_ids = match repo.get("skiplist.json") {
            Ok(skiplist_path) => {
                let content = std::fs::read_to_string(&skiplist_path)?;
                let ids: Vec<u32> = serde_json::from_str(&content)?;
                log_native(format!("[ColBERT-ORT] Loaded skiplist with {} token IDs", ids.len()));
                ids.into_iter().collect()
            }
            Err(_) => {
                log_native("[ColBERT-ORT] No skiplist found, using empty");
                HashSet::new()
            }
        };

        log_native(format!("[ColBERT-ORT] Loading model from {:?}", model_path));

        let session = Session::builder()?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_intra_threads(4)?  // Reduced from 8 to avoid thread contention
            .commit_from_file(&model_path)?;

        let tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|e| anyhow::anyhow!("Failed to load tokenizer: {}", e))?;

        // Get special token IDs
        let vocab = tokenizer.get_vocab(true);

        let cls_id = *vocab.get("[CLS]").unwrap_or(&0);
        let sep_id = *vocab.get("[SEP]").unwrap_or(&0);
        let mask_id = *vocab.get("[MASK]").unwrap_or(&0);
        let pad_id = *vocab.get("[PAD]").unwrap_or(&mask_id); // Use MASK as PAD if no PAD

        // ColBERT marker tokens (may not exist in all tokenizers)
        let query_marker_id = vocab.get(QUERY_MARKER).copied();
        let doc_marker_id = vocab.get(DOC_MARKER).copied();

        log_native(format!("[ColBERT-ORT] Token IDs: CLS={}, SEP={}, MASK={}, PAD={}",
            cls_id, sep_id, mask_id, pad_id));
        log_native(format!("[ColBERT-ORT] Marker IDs: [Q]={:?}, [D]={:?}",
            query_marker_id, doc_marker_id));
        log_native("[ColBERT-ORT] Model loaded successfully");

        Ok(Self {
            session,
            tokenizer,
            hidden_size,
            cls_id,
            sep_id,
            mask_id,
            pad_id,
            query_marker_id,
            doc_marker_id,
            skip_ids,
        })
    }

    /// Encode a query with ColBERT format: [CLS] [Q] tokens... [SEP] [MASK]...
    /// Pads with [MASK] tokens to QUERY_MAXLEN for query expansion
    pub fn encode_query(&mut self, text: &str) -> anyhow::Result<QueryEmbedding> {
        // If the tokenizer doesn't have a dedicated [Q] token, mimic the Python
        // harness behavior by prefixing the literal string "[Q] ".
        let text_for_tokenizer;
        let text = if self.query_marker_id.is_none() && !text.starts_with("[Q]") {
            text_for_tokenizer = format!("[Q] {}", text);
            text_for_tokenizer.as_str()
        } else {
            text
        };

        // Tokenize without special tokens
        let encoding = self.tokenizer
            .encode(text, false)
            .map_err(|e| anyhow::anyhow!("Tokenization failed: {}", e))?;

        let token_ids = encoding.get_ids();

        // Build sequence: [CLS] [Q]? tokens... [SEP] [MASK]...
        let mut final_ids: Vec<u32> = Vec::with_capacity(QUERY_MAXLEN);
        final_ids.push(self.cls_id);

        if let Some(q_id) = self.query_marker_id {
            final_ids.push(q_id);
        }

        // Add tokens (truncate if needed, leaving room for SEP)
        let max_tokens = QUERY_MAXLEN - final_ids.len() - 1; // -1 for SEP
        for &id in token_ids.iter().take(max_tokens) {
            final_ids.push(id);
        }

        final_ids.push(self.sep_id);

        // Pad with [MASK] for query expansion
        while final_ids.len() < QUERY_MAXLEN {
            final_ids.push(self.mask_id);
        }

        // Create attention mask (all 1s, MASK tokens are attended)
        let attention_mask: Vec<i64> = vec![1i64; final_ids.len()];
        let input_ids: Vec<i64> = final_ids.iter().map(|&id| id as i64).collect();

        let seq_len = input_ids.len();

        // Create tensors
        let input_ids_tensor = Value::from_array(([1usize, seq_len], input_ids))?;
        let attention_mask_tensor = Value::from_array(([1usize, seq_len], attention_mask))?;

        // Run inference
        let outputs = self.session.run(ort::inputs![
            "input_ids" => input_ids_tensor,
            "attention_mask" => attention_mask_tensor
        ])?;

        // Get embeddings [1, seq_len, hidden_size]
        let embeddings_tensor = outputs[0].try_extract_tensor::<f32>()?;
        let embeddings_data: &[f32] = embeddings_tensor.1;

        // Copy to owned vec and L2 normalize each token
        let mut embeddings = vec![0.0f32; seq_len * self.hidden_size];
        for s in 0..seq_len {
            let src_offset = s * self.hidden_size;
            let dst_offset = s * self.hidden_size;

            // L2 normalize
            let mut sum_sq = 0.0f32;
            for d in 0..self.hidden_size {
                let val = embeddings_data[src_offset + d];
                sum_sq += val * val;
            }
            let norm = sum_sq.sqrt().max(1e-12);

            for d in 0..self.hidden_size {
                embeddings[dst_offset + d] = embeddings_data[src_offset + d] / norm;
            }
        }

        Ok(QueryEmbedding {
            embeddings,
            seq_len,
            hidden_size: self.hidden_size,
        })
    }

    /// Encode documents in a batch: [CLS] [D]? tokens... [SEP]
    pub fn encode_docs(&mut self, texts: &[String]) -> anyhow::Result<Vec<DocEmbedding>> {
        if texts.is_empty() {
            return Ok(vec![]);
        }

        let batch_size = texts.len();

        // Tokenize all texts
        let mut all_token_ids: Vec<Vec<u32>> = Vec::with_capacity(batch_size);
        let mut max_len = 0usize;

        for text in texts {
            // If the tokenizer doesn't have a dedicated [D] token, mimic the Python
            // harness behavior by prefixing the literal string "[D] ".
            let text_for_tokenizer;
            let text = if self.doc_marker_id.is_none() && !text.starts_with("[D]") {
                text_for_tokenizer = format!("[D] {}", text);
                text_for_tokenizer.as_str()
            } else {
                text.as_str()
            };

            let encoding = self.tokenizer
                .encode(text, false)
                .map_err(|e| anyhow::anyhow!("Tokenization failed: {}", e))?;

            let token_ids = encoding.get_ids();

            // Build sequence: [CLS] [D]? tokens... [SEP]
            let mut final_ids: Vec<u32> = Vec::with_capacity(DOC_MAXLEN);
            final_ids.push(self.cls_id);

            if let Some(d_id) = self.doc_marker_id {
                final_ids.push(d_id);
            }

            // Add tokens (truncate if needed)
            let max_tokens = DOC_MAXLEN - final_ids.len() - 1;
            for &id in token_ids.iter().take(max_tokens) {
                final_ids.push(id);
            }

            final_ids.push(self.sep_id);

            if final_ids.len() > max_len {
                max_len = final_ids.len();
            }

            all_token_ids.push(final_ids);
        }

        // Pad to max_len and create batched tensors
        let mut input_ids_vec = vec![0i64; batch_size * max_len];
        let mut attention_mask_vec = vec![0i64; batch_size * max_len];
        let mut real_lengths: Vec<usize> = Vec::with_capacity(batch_size);

        for (i, ids) in all_token_ids.iter().enumerate() {
            let real_len = ids.len();
            real_lengths.push(real_len);

            for (j, &id) in ids.iter().enumerate() {
                input_ids_vec[i * max_len + j] = id as i64;
                attention_mask_vec[i * max_len + j] = 1;
            }
            // Remaining positions stay 0 (padded)
        }

        // Create tensors
        let input_ids = Value::from_array(([batch_size, max_len], input_ids_vec))?;
        let attention_mask = Value::from_array(([batch_size, max_len], attention_mask_vec))?;

        // Run inference
        let outputs = self.session.run(ort::inputs![
            "input_ids" => input_ids,
            "attention_mask" => attention_mask
        ])?;

        // Get embeddings [batch, max_len, hidden_size]
        let embeddings_tensor = outputs[0].try_extract_tensor::<f32>()?;
        let embeddings_data: &[f32] = embeddings_tensor.1;

        // Extract per-document embeddings with L2 normalization
        let mut results: Vec<DocEmbedding> = Vec::with_capacity(batch_size);

        for b in 0..batch_size {
            let real_len = real_lengths[b];
            let token_ids = &all_token_ids[b];
            let mut embeddings = vec![0.0f32; real_len * self.hidden_size];

            for s in 0..real_len {
                let src_offset = b * max_len * self.hidden_size + s * self.hidden_size;
                let dst_offset = s * self.hidden_size;

                // L2 normalize each token embedding
                let mut sum_sq = 0.0f32;
                for d in 0..self.hidden_size {
                    let val = embeddings_data[src_offset + d];
                    sum_sq += val * val;
                }
                let norm = sum_sq.sqrt().max(1e-12);

                for d in 0..self.hidden_size {
                    embeddings[dst_offset + d] = embeddings_data[src_offset + d] / norm;
                }
            }

            results.push(DocEmbedding {
                embeddings,
                token_ids: token_ids.clone(),
                seq_len: real_len,
                hidden_size: self.hidden_size,
            });
        }

        Ok(results)
    }

    /// MaxSim scoring: for each query token, find max similarity with doc tokens, sum
    pub fn max_sim(&self, query: &QueryEmbedding, doc: &DocEmbedding) -> f32 {
        let mut total_score = 0.0f32;

        for q in 0..query.seq_len {
            let q_offset = q * query.hidden_size;
            let mut max_dot = f32::NEG_INFINITY;

            for d in 0..doc.seq_len {
                // Skip tokens in skiplist (punctuation, special tokens)
                if self.skip_ids.contains(&doc.token_ids[d]) {
                    continue;
                }

                let d_offset = d * doc.hidden_size;

                // Dot product (vectors are already L2 normalized)
                let mut dot = 0.0f32;
                for k in 0..query.hidden_size {
                    dot += query.embeddings[q_offset + k] * doc.embeddings[d_offset + k];
                }

                if dot > max_dot {
                    max_dot = dot;
                }
            }

            if max_dot > f32::NEG_INFINITY {
                total_score += max_dot;
            }
        }

        total_score
    }

    /// Rerank documents against a query, return sorted indices and scores
    pub fn rerank(&mut self, query: &str, docs: &[String], top_k: usize) -> anyhow::Result<RerankResultOrt> {
        use std::time::Instant;

        // Encode query
        let t0 = Instant::now();
        let query_emb = self.encode_query(query)?;
        let query_time = t0.elapsed();

        // Encode docs in batches (larger batch = better throughput)
        let t1 = Instant::now();
        let batch_size = 64;
        let mut all_doc_embs: Vec<DocEmbedding> = Vec::with_capacity(docs.len());

        for chunk in docs.chunks(batch_size) {
            let chunk_vec: Vec<String> = chunk.to_vec();
            let embs = self.encode_docs(&chunk_vec)?;
            all_doc_embs.extend(embs);
        }
        let doc_time = t1.elapsed();

        // Score all docs
        let t2 = Instant::now();
        let mut scores: Vec<(usize, f32)> = all_doc_embs
            .iter()
            .enumerate()
            .map(|(i, doc_emb)| (i, self.max_sim(&query_emb, doc_emb)))
            .collect();
        let score_time = t2.elapsed();

        // Log timing once
        static LOGGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if !LOGGED.swap(true, std::sync::atomic::Ordering::Relaxed) {
            log_native(format!(
                "[ColBERT-ORT] Timing: query={:?} docs={:?} maxsim={:?}",
                query_time, doc_time, score_time
            ));
        }

        // Sort by score descending
        scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        // Take top_k
        let k = std::cmp::min(top_k, scores.len());
        let top_indices: Vec<u32> = scores[..k].iter().map(|(i, _)| *i as u32).collect();
        let top_scores: Vec<f64> = scores[..k].iter().map(|(_, s)| *s as f64).collect();
        let checksum: f64 = scores.iter().map(|(_, s)| *s as f64).sum();

        Ok(RerankResultOrt {
            indices: top_indices,
            scores: top_scores,
            checksum,
        })
    }
}

#[derive(Clone)]
pub struct QueryEmbedding {
    pub embeddings: Vec<f32>,  // [seq_len * hidden_size] flattened
    pub seq_len: usize,
    pub hidden_size: usize,
}

#[derive(Clone)]
pub struct DocEmbedding {
    pub embeddings: Vec<f32>,  // [seq_len * hidden_size] flattened
    pub token_ids: Vec<u32>,   // For skiplist filtering
    pub seq_len: usize,
    pub hidden_size: usize,
}

pub struct RerankResultOrt {
    pub indices: Vec<u32>,
    pub scores: Vec<f64>,
    pub checksum: f64,
}

/// Packed document embeddings for storage/retrieval
/// All embeddings are flattened into a single buffer with offsets
#[derive(Clone)]
pub struct PackedDocEmbeddings {
    /// Flattened embeddings: all docs concatenated [sum(lengths) * hidden_size]
    pub embeddings: Vec<f32>,
    /// Token IDs for skiplist: all docs concatenated [sum(lengths)]
    pub token_ids: Vec<u32>,
    /// Number of tokens per document
    pub lengths: Vec<u32>,
    /// Byte offsets into embeddings buffer for each doc (for fast lookup)
    pub offsets: Vec<u32>,
    /// Hidden dimension
    pub hidden_size: usize,
}

impl ColbertEncoderOrt {
    /// Encode documents and return packed embeddings for storage
    /// This is for INDEX TIME - encode once, store, reuse at query time
    pub fn encode_docs_packed(&mut self, texts: &[String]) -> anyhow::Result<PackedDocEmbeddings> {
        if texts.is_empty() {
            return Ok(PackedDocEmbeddings {
                embeddings: vec![],
                token_ids: vec![],
                lengths: vec![],
                offsets: vec![],
                hidden_size: self.hidden_size,
            });
        }

        // Encode in batches
        let batch_size = 64;
        let mut all_embeddings: Vec<f32> = Vec::new();
        let mut all_token_ids: Vec<u32> = Vec::new();
        let mut lengths: Vec<u32> = Vec::with_capacity(texts.len());
        let mut offsets: Vec<u32> = Vec::with_capacity(texts.len());

        for chunk in texts.chunks(batch_size) {
            let chunk_vec: Vec<String> = chunk.to_vec();
            let doc_embs = self.encode_docs(&chunk_vec)?;

            for doc in doc_embs {
                offsets.push(all_embeddings.len() as u32);
                lengths.push(doc.seq_len as u32);
                all_embeddings.extend(doc.embeddings);
                all_token_ids.extend(doc.token_ids);
            }
        }

        Ok(PackedDocEmbeddings {
            embeddings: all_embeddings,
            token_ids: all_token_ids,
            lengths,
            offsets,
            hidden_size: self.hidden_size,
        })
    }

    /// Score a query against pre-computed packed embeddings
    /// This is for QUERY TIME - no doc encoding needed
    pub fn score_packed(
        &self,
        query_emb: &QueryEmbedding,
        packed: &PackedDocEmbeddings,
        doc_indices: &[usize],  // Which docs from packed to score
    ) -> Vec<f32> {
        let mut scores = Vec::with_capacity(doc_indices.len());

        for &doc_idx in doc_indices {
            if doc_idx >= packed.lengths.len() {
                scores.push(0.0);
                continue;
            }

            let doc_len = packed.lengths[doc_idx] as usize;
            let emb_offset = packed.offsets[doc_idx] as usize;
            let token_offset: usize = packed.offsets[..doc_idx]
                .iter()
                .zip(&packed.lengths[..doc_idx])
                .map(|(&off, &len)| len as usize)
                .sum();

            // MaxSim scoring
            let mut total_score = 0.0f32;

            for q in 0..query_emb.seq_len {
                let q_offset = q * query_emb.hidden_size;
                let mut max_dot = f32::NEG_INFINITY;

                for d in 0..doc_len {
                    // Check skiplist
                    let token_id = packed.token_ids[token_offset + d];
                    if self.skip_ids.contains(&token_id) {
                        continue;
                    }

                    let d_offset = emb_offset + d * packed.hidden_size;

                    // Dot product
                    let mut dot = 0.0f32;
                    for k in 0..query_emb.hidden_size {
                        dot += query_emb.embeddings[q_offset + k]
                             * packed.embeddings[d_offset + k];
                    }

                    if dot > max_dot {
                        max_dot = dot;
                    }
                }

                if max_dot > f32::NEG_INFINITY {
                    total_score += max_dot;
                }
            }

            scores.push(total_score);
        }

        scores
    }

    /// Rerank using pre-computed packed embeddings (FAST query-time path)
    pub fn rerank_from_packed(
        &mut self,
        query: &str,
        packed: &PackedDocEmbeddings,
        doc_indices: &[usize],
        top_k: usize,
    ) -> anyhow::Result<RerankResultOrt> {
        use std::time::Instant;

        // Encode query only
        let t0 = Instant::now();
        let query_emb = self.encode_query(query)?;
        let query_time = t0.elapsed();

        // Score against packed embeddings
        let t1 = Instant::now();
        let raw_scores = self.score_packed(&query_emb, packed, doc_indices);
        let score_time = t1.elapsed();

        // Log timing
        static LOGGED_PACKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if !LOGGED_PACKED.swap(true, std::sync::atomic::Ordering::Relaxed) {
            log_native(format!(
                "[ColBERT-ORT] Packed timing: query={:?} maxsim={:?}",
                query_time, score_time
            ));
        }

        // Sort by score descending
        let mut indexed_scores: Vec<(usize, f32)> = raw_scores
            .iter()
            .enumerate()
            .map(|(i, &s)| (doc_indices[i], s))
            .collect();
        indexed_scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        // Take top_k
        let k = std::cmp::min(top_k, indexed_scores.len());
        let top_indices: Vec<u32> = indexed_scores[..k].iter().map(|(i, _)| *i as u32).collect();
        let top_scores: Vec<f64> = indexed_scores[..k].iter().map(|(_, s)| *s as f64).collect();
        let checksum: f64 = raw_scores.iter().map(|&s| s as f64).sum();

        Ok(RerankResultOrt {
            indices: top_indices,
            scores: top_scores,
            checksum,
        })
    }
}
