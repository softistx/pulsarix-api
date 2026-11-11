# Bun bundles the app and its dependencies into dist/server.js (the SDL files are
# imported as text by the module manifests): the image holds dist/ and the one
# two packages the bundle leaves out, @napi-rs/canvas and pdfjs-dist. No TypeScript, no other
# node_modules. Pinned to Bun 1.4.4 exactly, moved together with ci.yml's
# setup-bun and @types/bun.

FROM oven/bun:1.4.4 AS build
WORKDIR /app
# The in-memory Mongo and Redis are for the specs only: no binary download.
ENV MONGOMS_DISABLE_POSTINSTALL=1 REDISMS_DISABLE_POSTINSTALL=1
COPY package.json bun.lock* bunfig.toml* ./
# GITHUB_TOKEN (read:packages) is a build secret for the @softistx scope:
# docker build --secret id=GITHUB_TOKEN,env=GITHUB_TOKEN
RUN --mount=type=secret,id=GITHUB_TOKEN,env=GITHUB_TOKEN bun install --frozen-lockfile
COPY . .
# dist/server.js, and dist/scripts/pdf-preview-check.js (run below).
RUN bun run build && bun run build:scripts
# The PDF preview packages, installed alone for the final image at the exact
# versions the lockfile resolved. @softistx/image/pdf resolves pdfjs-dist at run
# time (it reads its fonts and cmaps from the package folder), and
# @napi-rs/canvas ships a prebuilt binary per platform and libc (linux
# x64/arm64, glibc and musl); the install picks the one for the image's own.
RUN mkdir /native && cd /native \
  && printf '{"name":"native","private":true,"dependencies":{"@napi-rs/canvas":"%s","pdfjs-dist":"%s"}}' \
       "$(bun -p 'require("/app/node_modules/@napi-rs/canvas/package.json").version')" \
       "$(bun -p 'require("/app/node_modules/pdfjs-dist/package.json").version')" > package.json \
  && bun install --production

# glibc (Debian slim), not Alpine: @napi-rs/canvas's glibc builds are the most
# used ones (linux-x64-gnu, linux-arm64-gnu), the Skia binary needs no system
# library beyond libc, and PDF text is drawn from the fonts pdfjs embeds or
# falls back to, so fontconfig plus one font keeps non-embedded fonts legible.
# The musl builds exist too; moving to Alpine saves about 80 MB and is one line
# here plus the fonts package, with the check below as the guard.
FROM oven/bun:1.4.4-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY --from=build /native/node_modules ./node_modules
# The native module and the PDF renderer work in THIS image: a wrong binary
# fails the build here, not the first PDF upload.
RUN bun --no-install dist/scripts/pdf-preview-check.js
USER bun
EXPOSE 3000
CMD ["bun", "--no-install", "dist/server.js"]
