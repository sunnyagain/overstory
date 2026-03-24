FROM debian:bookworm-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    tmux \
    curl \
    ca-certificates \
    bash \
    jq \
    unzip \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -u 1000 -s /bin/bash devuser

# Switch to devuser to install Bun in their home directory
USER devuser
WORKDIR /home/devuser

# Install Bun (>= 1.1 required for text lockfile format)
RUN curl -fsSL https://bun.sh/install | bash

# Set PATH to include Bun binary
ENV PATH="/home/devuser/.bun/bin:$PATH"

# Configure git safe directory for mounted workspace
RUN git config --global safe.directory /workspaces/overstory

USER devuser
WORKDIR /workspaces/overstory
