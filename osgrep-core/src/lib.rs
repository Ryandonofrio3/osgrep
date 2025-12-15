//! osgrep-core: Fast embedding and reranking via ONNX Runtime
//!
//! This is the native performance core of osgrep. It provides:
//! - Dense embeddings (384-dim, granite-30m)
//! - ColBERT token embeddings (48-dim, mxbai-edge-colbert-17m)
//! - MaxSim reranking with pre-indexed documents

#[macro_use]
extern crate napi_derive;

use napi::bindgen_prelude::*;
use once_cell::sync::OnceCell;
use std::sync::Mutex;

mod dense_ort;
mod colbert_ort;

use dense_ort::DenseEncoderOrt;
use colbert_ort::{ColbertEncoderOrt, PackedDocEmbeddings};

// =============================================================================
// Global Model Storage (initialized once, reused)
// =============================================================================

static DENSE_MODEL: OnceCell<Mutex<DenseEncoderOrt>> = OnceCell::new();
static COLBERT_MODEL: OnceCell<Mutex<ColbertEncoderOrt>> = OnceCell::new();

// =============================================================================
// Initialization
// =============================================================================

/// Initialize both models. Call once at startup.
///
/// dense_repo: HF repo like "onnx-community/granite-embedding-30m-english-ONNX"
/// colbert_repo: HF repo like "ryandono/mxbai-edge-colbert-v0-17m-onnx-int8"
#[napi]
pub fn init_models(dense_repo: String, colbert_repo: String) -> Result<()> {
    // Initialize dense model
    if DENSE_MODEL.get().is_none() {
        let encoder = DenseEncoderOrt::load_from_hf(&dense_repo, 384)
            .map_err(|e| Error::from_reason(format!("Failed to load dense model: {:?}", e)))?;
        DENSE_MODEL.set(Mutex::new(encoder))
            .map_err(|_| Error::from_reason("Dense model already initialized"))?;
    }

    // Initialize ColBERT model
    if COLBERT_MODEL.get().is_none() {
        let encoder = ColbertEncoderOrt::load_from_hf(&colbert_repo, 48)
            .map_err(|e| Error::from_reason(format!("Failed to load ColBERT model: {:?}", e)))?;
        COLBERT_MODEL.set(Mutex::new(encoder))
            .map_err(|_| Error::from_reason("ColBERT model already initialized"))?;
    }

    Ok(())
}

/// Check if models are initialized
#[napi]
pub fn is_initialized() -> bool {
    DENSE_MODEL.get().is_some() && COLBERT_MODEL.get().is_some()
}

// =============================================================================
// Dense Embeddings
// =============================================================================

#[napi(object)]
pub struct DenseResult {
    /// Flat array of embeddings [batch_size * 384]
    pub embeddings: Vec<f64>,
    /// Number of texts encoded
    pub count: u32,
}

/// Encode texts to dense vectors (384-dim, L2-normalized)
#[napi]
pub fn embed_dense(texts: Vec<String>) -> Result<DenseResult> {
    let model = DENSE_MODEL.get()
        .ok_or_else(|| Error::from_reason("Models not initialized. Call init_models() first."))?;

    let mut encoder = model.lock()
        .map_err(|e| Error::from_reason(format!("Failed to lock dense model: {:?}", e)))?;

    let embeddings_f32 = encoder.encode_batch(texts.clone(), true)
        .map_err(|e| Error::from_reason(format!("Dense encoding failed: {:?}", e)))?;

    Ok(DenseResult {
        embeddings: embeddings_f32.iter().map(|&x| x as f64).collect(),
        count: texts.len() as u32,
    })
}

// =============================================================================
// ColBERT Embeddings (for indexing)
// =============================================================================

#[napi(object)]
pub struct ColbertPackedResult {
    /// Packed embeddings as flat i8 array (all docs concatenated)
    pub embeddings: Vec<i8>,
    /// Token IDs for skiplist filtering
    pub token_ids: Vec<u32>,
    /// Number of tokens per document
    pub lengths: Vec<u32>,
    /// Byte offsets into embeddings for each doc
    pub offsets: Vec<u32>,
}

/// Encode documents to ColBERT embeddings (48-dim per token, packed for storage)
/// Call this at INDEX TIME to pre-compute embeddings
#[napi]
pub fn embed_colbert_packed(texts: Vec<String>) -> Result<ColbertPackedResult> {
    let model = COLBERT_MODEL.get()
        .ok_or_else(|| Error::from_reason("Models not initialized. Call init_models() first."))?;

    let mut encoder = model.lock()
        .map_err(|e| Error::from_reason(format!("Failed to lock ColBERT model: {:?}", e)))?;

    let packed = encoder.encode_docs_packed(&texts)
        .map_err(|e| Error::from_reason(format!("ColBERT encoding failed: {:?}", e)))?;

    // Convert f32 embeddings to i8 (quantized)
    let embeddings_i8: Vec<i8> = packed.embeddings.iter()
        .map(|&x| (x * 127.0).clamp(-128.0, 127.0) as i8)
        .collect();

    Ok(ColbertPackedResult {
        embeddings: embeddings_i8,
        token_ids: packed.token_ids,
        lengths: packed.lengths,
        offsets: packed.offsets,
    })
}

// =============================================================================
// ColBERT Reranking (for search)
// =============================================================================

#[napi(object)]
pub struct RerankResult {
    /// Original indices of top-k documents
    pub indices: Vec<u32>,
    /// MaxSim scores for top-k documents
    pub scores: Vec<f64>,
}

/// Encode a query for ColBERT reranking
/// Returns the query matrix as flat f64 array [seq_len * 48]
#[napi]
pub fn encode_query_colbert(query: String) -> Result<Vec<f64>> {
    let model = COLBERT_MODEL.get()
        .ok_or_else(|| Error::from_reason("Models not initialized. Call init_models() first."))?;

    let mut encoder = model.lock()
        .map_err(|e| Error::from_reason(format!("Failed to lock ColBERT model: {:?}", e)))?;

    let query_emb = encoder.encode_query(&query)
        .map_err(|e| Error::from_reason(format!("Query encoding failed: {:?}", e)))?;

    Ok(query_emb.embeddings.iter().map(|&x| x as f64).collect())
}

/// Rerank documents using pre-indexed ColBERT embeddings
///
/// query_embeddings: flat f64 array from encode_query_colbert [seq_len * 48]
/// doc_embeddings: flat i8 array (packed ColBERT embeddings)
/// doc_lengths: number of tokens per document
/// doc_offsets: byte offset for each document in doc_embeddings
/// candidate_indices: which docs to rerank (e.g., top-100 from dense retrieval)
/// top_k: how many to return
#[napi]
pub fn rerank_colbert(
    query_embeddings: Float64Array,
    doc_embeddings: Int8Array,
    doc_token_ids: Uint32Array,
    doc_lengths: Vec<u32>,
    doc_offsets: Vec<u32>,
    candidate_indices: Vec<u32>,
    top_k: u32,
) -> Result<RerankResult> {
    let model = COLBERT_MODEL.get()
        .ok_or_else(|| Error::from_reason("Models not initialized. Call init_models() first."))?;

    let encoder = model.lock()
        .map_err(|e| Error::from_reason(format!("Failed to lock ColBERT model: {:?}", e)))?;

    let query_embeddings = query_embeddings.to_vec();
    let doc_embeddings = doc_embeddings.to_vec();
    let doc_token_ids = doc_token_ids.to_vec();

    let hidden_size = 48usize;
    let query_seq_len = query_embeddings.len() / hidden_size;

    // Reconstruct query embedding struct
    let query_emb = colbert_ort::QueryEmbedding {
        embeddings: query_embeddings.iter().map(|&x| x as f32).collect(),
        seq_len: query_seq_len,
        hidden_size,
    };

    // Reconstruct packed doc embeddings (convert i8 back to f32)
    let doc_embeddings_f32: Vec<f32> = doc_embeddings.iter()
        .map(|&x| (x as f32) / 127.0)
        .collect();

    let packed = PackedDocEmbeddings {
        embeddings: doc_embeddings_f32,
        token_ids: doc_token_ids,
        lengths: doc_lengths,
        offsets: doc_offsets,
        hidden_size,
    };

    // Score candidates
    let indices: Vec<usize> = candidate_indices.iter().map(|&i| i as usize).collect();
    let scores = encoder.score_packed(&query_emb, &packed, &indices);

    // Sort by score descending
    let mut indexed_scores: Vec<(usize, f32)> = indices.iter()
        .zip(scores.iter())
        .map(|(&i, &s)| (i, s))
        .collect();
    indexed_scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    // Take top-k
    let k = std::cmp::min(top_k as usize, indexed_scores.len());

    Ok(RerankResult {
        indices: indexed_scores[..k].iter().map(|(i, _)| *i as u32).collect(),
        scores: indexed_scores[..k].iter().map(|(_, s)| *s as f64).collect(),
    })
}

// =============================================================================
// Convenience: Combined embed for indexing
// =============================================================================

#[napi(object)]
pub struct EmbedResult {
    /// Dense embeddings [batch_size * 384]
    pub dense: Vec<f64>,
    /// Packed ColBERT embeddings (i8)
    pub colbert_embeddings: Vec<i8>,
    /// Token IDs for skiplist filtering (all docs concatenated)
    pub colbert_token_ids: Vec<u32>,
    /// Token counts per document
    pub colbert_lengths: Vec<u32>,
    /// Byte offsets per document
    pub colbert_offsets: Vec<u32>,
}

/// Embed texts for indexing (both dense and ColBERT in one call)
#[napi]
pub fn embed_batch(texts: Vec<String>) -> Result<EmbedResult> {
    let dense = embed_dense(texts.clone())?;
    let colbert = embed_colbert_packed(texts)?;

    Ok(EmbedResult {
        dense: dense.embeddings,
        colbert_embeddings: colbert.embeddings,
        colbert_token_ids: colbert.token_ids,
        colbert_lengths: colbert.lengths,
        colbert_offsets: colbert.offsets,
    })
}
