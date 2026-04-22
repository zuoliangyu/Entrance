#!/bin/bash

set -e

if [ ! -d ./.data ]; then
    mkdir -p ./.data
    [ -f ./.data/auth_secret ] || openssl rand -base64 32 > ./.data/auth_secret
fi

export ENTRANCE_DATA_DIR="$(pwd)/.data"
export AUTH_SECRET="$(tr -d '\n' < ./.data/auth_secret)"

npm start
