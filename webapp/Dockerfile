# AI Job Search web app. Build context is the repo root, so the framework's
# skills, portal CLIs and LaTeX templates ship with the app unchanged.
FROM oven/bun:1.3.8-debian

# TeX Live from apt: the same package set the repo's CI uses to compile the
# stock CV (lualatex + moderncv + fontawesome5) and cover letter (xelatex +
# cover.cls). poppler-utils gives pdfinfo/pdftotext for page-count and ATS checks.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      texlive-luatex texlive-xetex texlive-latex-extra \
      texlive-fonts-extra texlive-fonts-recommended \
      poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/*

WORKDIR /repo

COPY .agents/skills ./.agents/skills
RUN for d in .agents/skills/*/cli; do (cd "$d" && bun install --production); done

COPY .claude/skills/job-application-assistant ./.claude/skills/job-application-assistant
COPY cv/main_example.tex ./cv/main_example.tex
COPY cover_letters ./cover_letters

COPY webapp/package.json ./webapp/package.json
RUN cd webapp && bun install --production
COPY webapp/src ./webapp/src
COPY webapp/public ./webapp/public

# Warm the LaTeX font caches so the first real compile isn't slow.
RUN cd /tmp && cp /repo/cv/main_example.tex . && lualatex -interaction=nonstopmode main_example.tex >/dev/null 2>&1; rm -f /tmp/main_example.*

ENV REPO_ROOT=/repo DATA_DIR=/data NODE_ENV=production
WORKDIR /repo/webapp
EXPOSE 8080
CMD ["bun", "run", "src/server.ts"]
