#!/bin/sh
# Fast pre-build for pi extension loading (bypasses jiti/babel)
exec npx esbuild src/index.ts --bundle --format=esm --platform=node --outfile=dist/index.js --packages=external 2>&1
