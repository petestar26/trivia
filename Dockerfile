FROM --platform=linux/amd64 docker.io/library/node@sha256:3d0f05455dea2c82e2f76e7e2543964c30f6b7d673fc1a83286736d44fe4c41c AS node_distribution
FROM --platform=linux/amd64 docker.io/library/postgres@sha256:e923a22ac074261dd73970c57edf659475bf0497cb9456f17d98ed7cdd3ca913 AS build
COPY --from=node_distribution /usr/local/bin/node /usr/local/bin/node
COPY --from=node_distribution /usr/local/lib/node_modules/corepack /usr/local/lib/node_modules/corepack
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CHECKPOINT_DISABLE=1
WORKDIR /opt/salem
COPY . /opt/salem/source/
RUN set -eu; mv source/.salem-linux-rehearsal/* /opt/salem/; rmdir source/.salem-linux-rehearsal; rm -f source/Dockerfile source/.dockerignore
RUN set -eu; cp -a source fallback; while IFS= read -r f; do rm -- "fallback/$f"; done < remove.txt; tar -xzf fallback-delta.tar.gz -C fallback; for side in source fallback; do (cd "$side" && sha256sum -c "../$side.sha256" >/dev/null && test "$(find . -type f | wc -l)" -eq "$(wc -l < "../$side.sha256")"); done; echo SALEM_EXACT_SOURCE_TREE_CONTENTS_PASS
RUN set -eu; test "$(node --version)" = v20.20.2; /usr/lib/postgresql/18/bin/psql --version | grep -Eq ' 18\.6([[:space:]]|$)'; c=/usr/local/lib/node_modules/corepack/dist/corepack.js; node "$c" enable --install-directory /usr/local/bin; for side in source fallback; do cd "/opt/salem/$side"; test "$(node "$c" pnpm --version)" = 8.15.9; node "$c" pnpm --filter api... install --frozen-lockfile; node "$c" pnpm --filter api build; node "$c" pnpm --filter api typecheck; test -s apps/api/dist/server.js; test -s apps/api/dist/scripts/ledger-runtime-identity-check.js; sha256sum apps/api/dist/server.js packages/database/prisma/schema.prisma; find node_modules/.pnpm -type f -name 'libquery_engine-debian-openssl-3.0.x.so.node' -exec sha256sum {} + > /tmp/engine-pins; test -s /tmp/engine-pins; awk '$1 != "35860a5c0fb2f79e7b38c40747c4d212318d97e1910ca528b133c802716de0b8" {bad=1} END{exit bad}' /tmp/engine-pins; done
RUN chmod -R a+rX /opt/salem
FROM scratch
COPY --from=build / /
WORKDIR /opt/salem
ENV PATH=/usr/lib/postgresql/18/bin:/usr/local/bin:/usr/bin:/bin
USER 65534:65534
CMD ["/bin/sh", "/opt/salem/run.sh"]
