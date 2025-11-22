#!/bin/bash

# osgrep Benchmark Runner
# Compares osgrep vs ripgrep vs grep on real-world repositories

set -e

REPO_DIR="${1:-$HOME/osgrep-benchmarks}"
SHOULD_INDEX="${2:-false}"

echo "🚀 osgrep Benchmark Suite"
echo "=========================="
echo ""
echo "📁 Repository directory: $REPO_DIR"
echo ""

# Check if repos exist
if [ ! -d "$REPO_DIR" ]; then
    echo "❌ Repository directory not found: $REPO_DIR"
    echo ""
    echo "Run these commands to set up test repos:"
    echo ""
    echo "  mkdir -p $REPO_DIR"
    echo "  cd $REPO_DIR"
    echo "  git clone --depth=1 https://github.com/tiangolo/fastapi.git"
    echo "  git clone --depth=1 https://github.com/vitejs/vite.git"
    echo "  git clone --depth=1 https://github.com/trpc/trpc.git"
    echo "  git clone --depth=1 https://github.com/drizzle-team/drizzle-orm.git"
    echo "  git clone --depth=1 https://github.com/colinhacks/zod.git"
    echo ""
    exit 1
fi

# Check if ripgrep is installed
if ! command -v rg &> /dev/null; then
    echo "⚠️  Warning: ripgrep (rg) not found. Install with:"
    echo "    brew install ripgrep"
    echo ""
fi

# Check if osgrep is installed
if ! command -v osgrep &> /dev/null; then
    echo "❌ osgrep not found. Install with:"
    echo "    npm install -g osgrep"
    exit 1
fi

echo "✅ Dependencies ready"
echo ""

# Build the benchmark script
echo "🔨 Building benchmark..."
pnpm build
node dist/benchmark.js "$REPO_DIR" ${SHOULD_INDEX:+--index}

