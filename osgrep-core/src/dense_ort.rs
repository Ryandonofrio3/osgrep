use ort::session::{Session, builder::GraphOptimizationLevel};
use ort::value::Value;
use tokenizers::Tokenizer;
use hf_hub::{api::sync::Api, Repo, RepoType};

fn log_native(msg: impl AsRef<str>) {
    // Intentionally no-op: native logging was polluting CLI output.
    // If you need debugging, add structured logging at the JS layer instead.
    let _ = msg.as_ref();
}

pub struct DenseEncoderOrt {
    session: Session,
    tokenizer: Tokenizer,
    hidden_size: usize,
}

impl DenseEncoderOrt {
    /// Load ONNX model and tokenizer from HuggingFace Hub
    /// repo_id: HF repo like "onnx-community/granite-embedding-30m-english-ONNX"
    pub fn load_from_hf(repo_id: &str, hidden_size: usize) -> anyhow::Result<Self> {
        log_native(format!("[ORT] Downloading model from HF hub: {}", repo_id));

        let api = Api::new()?;
        let repo = api.repo(Repo::new(repo_id.to_string(), RepoType::Model));

        // Download model and tokenizer files
        // ONNX model is in onnx/ subdirectory for onnx-community repos
        // Also download the external data file if it exists
        let model_path = repo.get("onnx/model.onnx")?;
        let _ = repo.get("onnx/model.onnx_data"); // External data, ignore if not found
        let tokenizer_path = repo.get("tokenizer.json")?;

        log_native(format!("[ORT] Loading model from {:?}", model_path));

        // Initialize ONNX Runtime session with CPU provider
        let session = Session::builder()?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_intra_threads(4)?
            .commit_from_file(&model_path)?;

        // Load tokenizer
        let mut tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|e| anyhow::anyhow!("Failed to load tokenizer: {}", e))?;

        // Configure truncation/padding (same as Candle)
        let max_len = 256usize;
        tokenizer.with_truncation(Some(tokenizers::TruncationParams {
            max_length: max_len,
            ..Default::default()
        })).map_err(|e| anyhow::anyhow!("Failed to set truncation: {}", e))?;

        tokenizer.with_padding(Some(tokenizers::PaddingParams {
            strategy: tokenizers::PaddingStrategy::BatchLongest,
            ..Default::default()
        }));

        log_native(format!("[ORT] Tokenizer configured with max_seq_len={}", max_len));
        log_native("[ORT] Model loaded successfully");

        Ok(Self {
            session,
            tokenizer,
            hidden_size,
        })
    }

    /// Load ONNX model and tokenizer from local paths
    pub fn load(model_path: &str, tokenizer_path: &str, hidden_size: usize) -> anyhow::Result<Self> {
        log_native(format!("[ORT] Loading model from {}", model_path));

        // Initialize ONNX Runtime session with CPU provider
        let session = Session::builder()?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_intra_threads(4)?
            .commit_from_file(model_path)?;

        // Load tokenizer
        let mut tokenizer = Tokenizer::from_file(tokenizer_path)
            .map_err(|e| anyhow::anyhow!("Failed to load tokenizer: {}", e))?;

        let max_len = 256usize;
        tokenizer.with_truncation(Some(tokenizers::TruncationParams {
            max_length: max_len,
            ..Default::default()
        })).map_err(|e| anyhow::anyhow!("Failed to set truncation: {}", e))?;

        tokenizer.with_padding(Some(tokenizers::PaddingParams {
            strategy: tokenizers::PaddingStrategy::BatchLongest,
            ..Default::default()
        }));

        log_native(format!("[ORT] Tokenizer configured with max_seq_len={}", max_len));
        log_native("[ORT] Model loaded successfully");

        Ok(Self {
            session,
            tokenizer,
            hidden_size,
        })
    }

    pub fn encode_batch(&mut self, texts: Vec<String>, normalize: bool) -> anyhow::Result<Vec<f32>> {
        if texts.is_empty() {
            return Err(anyhow::anyhow!("Empty input texts"));
        }

        // Tokenize
        let encodings = self.tokenizer
            .encode_batch(texts.clone(), true)
            .map_err(|e| anyhow::anyhow!("Tokenization failed: {}", e))?;

        let max_len = encodings.iter().map(|e| e.get_ids().len()).max().unwrap_or(0);
        let batch_size = encodings.len();

        // Log once
        static LOGGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if !LOGGED.swap(true, std::sync::atomic::Ordering::Relaxed) {
            log_native(format!("[ORT] First batch: batch_size={} max_seq_len={}", batch_size, max_len));
        }

        // Prepare input tensors
        let mut input_ids_vec = vec![0i64; batch_size * max_len];
        let mut attention_mask_vec = vec![0i64; batch_size * max_len];
        let mut token_type_ids_vec = vec![0i64; batch_size * max_len];

        for (i, encoding) in encodings.iter().enumerate() {
            let ids = encoding.get_ids();
            let mask = encoding.get_attention_mask();
            let type_ids = encoding.get_type_ids();

            for (j, &id) in ids.iter().enumerate() {
                input_ids_vec[i * max_len + j] = id as i64;
            }
            for (j, &m) in mask.iter().enumerate() {
                attention_mask_vec[i * max_len + j] = m as i64;
            }
            for (j, &t) in type_ids.iter().enumerate() {
                token_type_ids_vec[i * max_len + j] = t as i64;
            }
        }

        // Create ORT tensors - pass Vec directly, not slice
        let input_ids = Value::from_array(([batch_size, max_len], input_ids_vec))?;
        let attention_mask_tensor = Value::from_array(([batch_size, max_len], attention_mask_vec.clone()))?;
        let token_type_ids = Value::from_array(([batch_size, max_len], token_type_ids_vec))?;

        // Run inference
        let outputs = self.session.run(ort::inputs![
            "input_ids" => input_ids,
            "attention_mask" => attention_mask_tensor,
            "token_type_ids" => token_type_ids
        ])?;

        // Get the last_hidden_state output (typically first output)
        let embeddings_tensor = outputs[0].try_extract_tensor::<f32>()?;
        let embeddings_data: &[f32] = embeddings_tensor.1;

        // Mean pooling
        let mut pooled = vec![0.0f32; batch_size * self.hidden_size];
        for i in 0..batch_size {
            let mut sum_hidden = vec![0.0f32; self.hidden_size];
            let mut sum_mask = 0.0f32;

            for j in 0..max_len {
                let mask_val = attention_mask_vec[i * max_len + j] as f32;
                sum_mask += mask_val;

                for k in 0..self.hidden_size {
                    let emb_val = embeddings_data[i * max_len * self.hidden_size + j * self.hidden_size + k];
                    sum_hidden[k] += emb_val * mask_val;
                }
            }

            let denom = sum_mask.max(1e-9);
            for k in 0..self.hidden_size {
                pooled[i * self.hidden_size + k] = sum_hidden[k] / denom;
            }
        }

        // L2 normalize if requested
        if normalize {
            for i in 0..batch_size {
                let start = i * self.hidden_size;
                let end = start + self.hidden_size;
                let slice = &mut pooled[start..end];

                let norm = slice.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
                for val in slice.iter_mut() {
                    *val /= norm;
                }
            }
        }

        Ok(pooled)
    }

    pub fn compute_checksum(&mut self, texts: Vec<String>, normalize: bool) -> anyhow::Result<f64> {
        let embeddings = self.encode_batch(texts, normalize)?;
        let checksum: f64 = embeddings.iter().map(|&x| x as f64).sum();
        Ok(checksum)
    }

    /// Get the hidden size (embedding dimension)
    pub fn hidden_size(&self) -> usize {
        self.hidden_size
    }
}
