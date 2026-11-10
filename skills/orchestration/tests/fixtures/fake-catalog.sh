#!/bin/sh
# A deterministic catalog for tests: the same table shape `pi --list-models` prints.
cat <<'EOF'
provider     model                       context  max-out  thinking  images
test         model-fast                  128K     32K      yes       no
test         model-strong                256K     64K      yes       yes
other        model-backup                256K     64K      yes       yes
opencode-go  deepseek-v4.1-flash          1M       384K     yes       yes
opencode-go  deepseek-v4.1-flash-free     1M       384K     yes       yes
opencode-go  muse-spark-1.3-contributor  1M       131K     yes       yes
opencode-go  mimo-v2.6-flash             1M       131K     yes       yes
EOF
