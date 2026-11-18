# French Flair — Conteneur Blender headless + pont MCP (port 9876)
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends blender python3-numpy ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY bridge.py /app/bridge.py

# Dossier d'échange avec le serveur web (volume)
RUN mkdir -p /output
VOLUME ["/output"]

EXPOSE 9876

# -b : headless, --python : lance le pont (boucle TCP bloquante)
CMD ["blender", "-b", "--python", "/app/bridge.py"]
