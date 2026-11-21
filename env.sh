# Lord Marketplaces Analytics — ambiente portátil de desenvolvimento
# Uso: . ./env.sh   (a partir da raiz do projeto)
# Nada aqui é instalado no sistema: Node, Git, gh e pnpm vivem em ./tools.
# O runtime Node v22 embutido no instalador final é este mesmo.

# caminho absoluto (o shell do app não mantém $0 estável)
LMA_ROOT="C:/Users/ferro/LordMarketplacesAnalytics"
export LMA_ROOT
export PATH="$LMA_ROOT/tools/node-v22.14.0-win-x64:$LMA_ROOT/tools/gh/bin:$LMA_ROOT/tools/PortableGit/cmd:$PATH"
export NODE_PATH="$LMA_ROOT/tools/node-v22.14.0-win-x64/node_modules"
export GIT_EXEC_PATH="$LMA_ROOT/tools/PortableGit/mingw64/libexec/git-core"

echo "LMA_ROOT=$LMA_ROOT"
node -v
pnpm -v 2>/dev/null || echo "pnpm: rode 'npm i -g pnpm@9' se faltar"
git --version
gh --version | head -1
