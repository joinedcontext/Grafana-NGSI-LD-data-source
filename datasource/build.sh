#!/bin/sh
# Builds plugin/dist in Docker (no local Node needed), with the build stage of plugin/Dockerfile.
set -e
cd "$(dirname "$0")/plugin"
rm -rf dist
docker build --target dist --output dist .
