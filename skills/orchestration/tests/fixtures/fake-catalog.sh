#!/bin/sh
# A deterministic catalog for tests: the same table shape `pi --list-models` prints.
cat <<'EOF'
provider     model                       context  max-out  thinking  images
test         model-fast                  128K     32K      yes       no    
test         model-strong                256K     64K      yes       yes   
other        model-backup                256K     64K      yes       yes   
EOF
