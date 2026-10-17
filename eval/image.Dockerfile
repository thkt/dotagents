FROM debian@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
COPY --chmod=755 bun /usr/local/bin/bun
COPY codex-vendor/ /opt/codex/
RUN ln -s /opt/codex/bin/codex /usr/local/bin/codex && ln -s /opt/codex/codex-path/rg /usr/local/bin/rg && mkdir -p /home/eval && chown 1000:1000 /home/eval && printf 'eval:x:1000:1000:eval:/home/eval:/bin/sh\n' >> /etc/passwd && printf 'eval:x:1000:\n' >> /etc/group
ENV PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8
USER 1000:1000
WORKDIR /work
