// osgrep-core: Native embedding and reranking
// Auto-loads the correct binary for the current platform

import { createRequire } from 'module';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { platform, arch } = process;

let nativeBinding = null;
let loadError = null;

function isMusl() {
  if (!process.report || typeof process.report.getReport !== 'function') {
    try {
      const lddPath = execSync('which ldd').toString().trim();
      return require('fs').readFileSync(lddPath, 'utf8').includes('musl');
    } catch (e) {
      return true;
    }
  } else {
    const { glibcVersionRuntime } = process.report.getReport().header;
    return !glibcVersionRuntime;
  }
}

function tryLoad(localPath, packageName) {
  if (existsSync(join(__dirname, localPath))) {
    return require(`./${localPath}`);
  }
  return require(packageName);
}

switch (platform) {
  case 'darwin':
    switch (arch) {
      case 'arm64':
        try {
          nativeBinding = tryLoad('osgrep-core.darwin-arm64.node', '@osgrep-core/darwin-arm64');
        } catch (e) {
          loadError = e;
        }
        break;
      case 'x64':
        try {
          nativeBinding = tryLoad('osgrep-core.darwin-x64.node', '@osgrep-core/darwin-x64');
        } catch (e) {
          loadError = e;
        }
        break;
      default:
        throw new Error(`Unsupported architecture on macOS: ${arch}`);
    }
    break;
  case 'linux':
    switch (arch) {
      case 'x64':
        if (isMusl()) {
          try {
            nativeBinding = tryLoad('osgrep-core.linux-x64-musl.node', '@osgrep-core/linux-x64-musl');
          } catch (e) {
            loadError = e;
          }
        } else {
          try {
            nativeBinding = tryLoad('osgrep-core.linux-x64-gnu.node', '@osgrep-core/linux-x64-gnu');
          } catch (e) {
            loadError = e;
          }
        }
        break;
      default:
        throw new Error(`Unsupported architecture on Linux: ${arch}`);
    }
    break;
  case 'win32':
    switch (arch) {
      case 'x64':
        try {
          nativeBinding = tryLoad('osgrep-core.win32-x64-msvc.node', '@osgrep-core/win32-x64-msvc');
        } catch (e) {
          loadError = e;
        }
        break;
      default:
        throw new Error(`Unsupported architecture on Windows: ${arch}`);
    }
    break;
  default:
    throw new Error(`Unsupported OS: ${platform}, architecture: ${arch}`);
}

if (!nativeBinding) {
  if (loadError) {
    throw loadError;
  }
  throw new Error(`Failed to load native binding`);
}

// Clean API exports
export const {
  // Initialization
  initModels,
  isInitialized,

  // Dense embeddings (384-dim)
  embedDense,

  // ColBERT embeddings (48-dim per token, packed)
  embedColbertPacked,

  // ColBERT reranking
  encodeQueryColbert,
  rerankColbert,

  // Convenience: both embeddings in one call
  embedBatch,
} = nativeBinding;
