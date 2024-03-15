#!/bin/bash

set -e

(cd "$(dirname "$0")/../_site/" && python3 -m http.server 8000)
