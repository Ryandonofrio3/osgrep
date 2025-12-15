// Shared ignore patterns for filesystem walks.
// Keep JSON files (package.json, tsconfig.json, etc.) but skip lockfiles and obvious binaries.
export const DEFAULT_IGNORE_PATTERNS = [
  "*.lock",
  "*.bin",
  "*.ipynb",
  "*.pyc",
  "*.onnx",
  // Non-code text files (osgrep is for CODE search)
  "*.txt",
  "*.log",
  "*.csv",
  // Safety nets for nested non-git folders
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/target/**",
  "**/__pycache__/**",
  "**/coverage/**",
  "**/venv/**",
  // Test fixtures and benchmark data
  "**/fixtures/**",
  "**/benchmark/**",
  "**/testdata/**",
  "**/__fixtures__/**",
  "**/__snapshots__/**",
  // Lockfiles across ecosystems
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "composer.lock",
  "Cargo.lock",
  "Gemfile.lock",
  // Security: Sensitive files that should never be indexed
  ".env",
  ".env.*",
  "*.key",
  "*.pem",
  "*.p12",
  "*.pfx",
  "*.p8",
  "**/.ssh/**",
  "id_rsa",
  "id_ed25519",
  "*.pub",
  "**/.gnupg/**",
  "*.gpg",
  "**/.aws/**",
  "**/.gcloud/**",
  "**/.azure/**",
  "secrets.*",
  "credentials.*",
  // IDE and OS files
  ".DS_Store",
  "**/.idea/**",
  "**/.vscode/**",
  "Thumbs.db",
];

// Patterns for generated/auto-generated code files.
// These are still indexed but receive a score penalty in search results.
// Uses regex patterns (not globs) for matching against file paths.
export const GENERATED_FILE_PATTERNS: RegExp[] = [
  // TypeScript/JavaScript codegen
  /\.gen\.[jt]sx?$/i,
  /\.generated\.[jt]sx?$/i,
  /\.g\.[jt]sx?$/i,
  /_generated\.[jt]sx?$/i,
  // TypeScript declaration files (ambient types, often auto-generated)
  /\.d\.ts$/i,
  // GraphQL codegen
  /\.graphql\.[jt]sx?$/i,
  /\/__generated__\//i,
  // Protocol Buffers
  /\.pb\.[a-z]+$/i, // .pb.go, .pb.ts, etc.
  /_pb2\.py$/i, // Python protobuf
  /_pb2_grpc\.py$/i,
  // Go codegen
  /_gen\.go$/i,
  /_string\.go$/i, // stringer tool
  /\.gen\.go$/i,
  /mock_.*\.go$/i, // mockgen
  // C# codegen
  /\.Designer\.cs$/i,
  /\.g\.cs$/i,
  /\.g\.i\.cs$/i,
  // OpenAPI / Swagger
  /openapi.*\.gen\./i,
  /swagger.*\.gen\./i,
  // Prisma
  /prisma\/client\//i,
  // Generic patterns
  /\/generated\//i,
  /\/gen\//i,
  /\/codegen\//i,
];
