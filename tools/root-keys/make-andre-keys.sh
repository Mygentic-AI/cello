#!/bin/bash
# Makes Andre's two root keys on his Mac: the Secure Enclave key and the paper key.
# Run it in a terminal at the Mac. It asks for a passphrase twice. Nothing it asks for is shown or saved.
# It writes only public keys where Claude can read them; the paper sheet goes to the Desktop for printing.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dir="$HOME/.cello-root"
sheet="$HOME/Desktop/cello-paper-key.txt"
mkdir -p "$dir" && chmod 700 "$dir"

echo "1 of 2: the Mac chip key"
swiftc -O "$here/enclave.swift" -o "$dir/enclave"
"$dir/enclave" create "$dir/enclave.handle" > "$dir/enclave.public"
echo "   made. It never leaves this Mac's chip."

echo
echo "2 of 2: the paper key"
echo "   Choose a passphrase only you know, at least 20 characters. Five random words is good."
echo "   If you lose it, the paper is useless. It's typed, never shown."
node "$here/paper.ts" create "$sheet" > "$dir/paper.public"

echo
echo "Done. Both public keys are in $dir, for Claude."
echo "Now: print $sheet, then delete it and empty the Bin."
echo "Keep the printout and the passphrase in different places."
