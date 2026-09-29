# Oracle Linux 9 base image
FROM oraclelinux:9

#=====================
# Install required packages
#=====================
RUN dnf install -y \
    oraclelinux-developer-release-el9 \
    git \
    curl \
    tar \
    gzip \
    bash \
    shadow-utils \
    && dnf clean all

#=====================
# Install Node.js 22
#=====================
RUN curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - && \
    dnf install -y nodejs && \
    dnf clean all

#=====================
# install yarn
#=====================
RUN npm install -g yarn

#=====================
# Install Claude Code globally
#=====================
RUN npm install -g @anthropic-ai/claude-code

#=====================
# Install Codex globally
#=====================
RUN npm install -g @openai/codex

#=====================
# Install PI
#=====================
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent



#=====================
# Create non-root user 'claude' because we will allow tools to be used
#=====================
RUN useradd -m -u 1000 -s /bin/bash devworkshop

#=====================
# Switch to non-root user
#=====================
USER devworkshop


# Default shell
CMD ["/bin/bash"]