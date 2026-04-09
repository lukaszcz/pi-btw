# pi-btw — ask side-questions without polluting the main conversation

[private]
help:
    @just --list

# Install extension globally (~/.pi) or to a project folder
install target="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -z "{{target}}" ]; then
        dest="$HOME/.pi/agent/extensions/pi-btw"
    else
        dest="{{target}}/.pi/extensions/pi-btw"
    fi
    mkdir -p "$dest"
    cp package.json btw.ts "$dest/"
    echo "Installed pi-btw to $dest"
