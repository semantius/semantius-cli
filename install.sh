#!/bin/bash
# Install script for semantius-cli
# Usage: curl -fsSL https://raw.githubusercontent.com/semantius/semantius-cli/main/install.sh | bash

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# Cleanup on exit
TMP_FILE=""
TMP_CHECKSUM=""
cleanup() {
    if [ -n "$TMP_FILE" ] && [ -f "$TMP_FILE" ]; then
        rm -f "$TMP_FILE"
    fi
    if [ -n "$TMP_CHECKSUM" ] && [ -f "$TMP_CHECKSUM" ]; then
        rm -f "$TMP_CHECKSUM"
    fi
}
trap cleanup EXIT

# Detect OS and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
    linux)
        case "$ARCH" in
            x86_64) BINARY="semantius-linux-x64" ;;
            aarch64) BINARY="semantius-linux-arm64" ;;
            *) echo -e "${RED}Unsupported architecture: $ARCH${NC}"; exit 1 ;;
        esac
        ;;
    darwin)
        case "$ARCH" in
            x86_64) BINARY="semantius-darwin-x64" ;;
            arm64) BINARY="semantius-darwin-arm64" ;;
            *) echo -e "${RED}Unsupported architecture: $ARCH${NC}"; exit 1 ;;
        esac
        ;;
    mingw*|msys*|cygwin*)
        # Git Bash, MSYS2 or Cygwin on Windows: the Windows build and its PATH
        # setup come from install.ps1, which any shell can start.
        echo -e "${RED}Unsupported OS: $OS${NC}"
        echo "On Windows, install with PowerShell instead (this works from Git Bash too):"
        echo "  powershell -NoProfile -Command \"irm https://raw.githubusercontent.com/semantius/semantius-cli/main/install.ps1 | iex\""
        exit 1
        ;;
    *)
        echo -e "${RED}Unsupported OS: $OS${NC}"
        exit 1
        ;;
esac

# Installation directory: $INSTALL_DIR if set, else /usr/local/bin when it is
# writable (root, many Intel Macs), else ~/.local/bin (no sudo needed)
if [ -z "${INSTALL_DIR:-}" ]; then
    if [ -w "/usr/local/bin" ]; then
        INSTALL_DIR="/usr/local/bin"
    else
        INSTALL_DIR="$HOME/.local/bin"
    fi
fi

GITHUB_REPO="semantius/semantius-cli"

# Print banner
echo ""
echo -e "${BOLD}Installing semantius${NC}"
echo ""
echo -e "  ${BOLD}Platform${NC}:  $OS/$ARCH"
echo -e "  ${BOLD}Binary${NC}:    $BINARY"
echo -e "  ${BOLD}Location${NC}:  $INSTALL_DIR/semantius"
echo ""

INSTALLED="$INSTALL_DIR/semantius"

# Check for existing installation: the one on PATH may live somewhere else
EXISTING=$(command -v semantius 2>/dev/null || true)
if [ -n "$EXISTING" ]; then
    EXISTING_VERSION=$("$EXISTING" --version 2>/dev/null || echo "unknown")
    if [ "$EXISTING" -ef "$INSTALLED" ]; then
        echo -e "${YELLOW}Note: Updating existing installation ($EXISTING_VERSION)${NC}"
    else
        echo -e "${YELLOW}Note: Another semantius is on your PATH: $EXISTING ($EXISTING_VERSION)${NC}"
    fi
    echo ""
fi

# Get latest release URL
DOWNLOAD_URL="https://github.com/$GITHUB_REPO/releases/latest/download/$BINARY"
CHECKSUM_URL="https://github.com/$GITHUB_REPO/releases/latest/download/checksums.txt"

# Download binary
echo -e "${BLUE}Downloading...${NC}"
TMP_FILE=$(mktemp)
if ! curl -fsSL "$DOWNLOAD_URL" -o "$TMP_FILE"; then
    echo -e "${RED}Failed to download binary. Check if releases exist at:${NC}"
    echo "  https://github.com/$GITHUB_REPO/releases"
    exit 1
fi

# Verify checksum (if available)
TMP_CHECKSUM=$(mktemp)
if curl -fsSL "$CHECKSUM_URL" -o "$TMP_CHECKSUM" 2>/dev/null; then
    # Extract checksum for our binary
    EXPECTED_CHECKSUM=$(grep "$BINARY" "$TMP_CHECKSUM" | awk '{print $1}')
    if [ -n "$EXPECTED_CHECKSUM" ]; then
        echo -e "${BLUE}Verifying checksum...${NC}"
        # Calculate actual checksum
        if command -v sha256sum &> /dev/null; then
            ACTUAL_CHECKSUM=$(sha256sum "$TMP_FILE" | awk '{print $1}')
        elif command -v shasum &> /dev/null; then
            ACTUAL_CHECKSUM=$(shasum -a 256 "$TMP_FILE" | awk '{print $1}')
        else
            echo -e "${YELLOW}Warning: Could not verify checksum (no sha256sum/shasum found)${NC}"
            ACTUAL_CHECKSUM=""
        fi

        if [ -n "$ACTUAL_CHECKSUM" ]; then
            if [ "$EXPECTED_CHECKSUM" != "$ACTUAL_CHECKSUM" ]; then
                echo -e "${RED}Checksum verification failed!${NC}"
                echo "Expected: $EXPECTED_CHECKSUM"
                echo "Actual: $ACTUAL_CHECKSUM"
                exit 1
            fi
            echo -e "${GREEN}✓${NC} Checksum verified"
        fi
    fi
fi

# Make executable
chmod +x "$TMP_FILE"

# Create install directory if needed
if [ ! -d "$INSTALL_DIR" ]; then
    echo -e "${BLUE}Creating $INSTALL_DIR...${NC}"
    mkdir -p "$INSTALL_DIR"
fi

# Install
echo -e "${BLUE}Installing...${NC}"
if [ -w "$INSTALL_DIR" ]; then
    mv "$TMP_FILE" "$INSTALLED"
else
    echo -e "${YELLOW}Requires sudo to install to $INSTALL_DIR${NC}"
    sudo mv "$TMP_FILE" "$INSTALLED"
fi
TMP_FILE=""  # Clear so cleanup doesn't try to delete

# Success message
echo ""
echo -e "${GREEN}✓ semantius installed successfully!${NC}"
echo ""

# Which semantius the shell finds now. The lookup above may have been hashed
# to an older binary; forget it so this sees the PATH as it is.
hash -r 2>/dev/null || true
FOUND=$(command -v semantius 2>/dev/null || true)

# Whether $INSTALL_DIR is on PATH at all
case ":$PATH:" in
    *":$INSTALL_DIR:"*) ON_PATH=1 ;;
    *) ON_PATH="" ;;
esac

if [ -n "$FOUND" ] && [ "$FOUND" -ef "$INSTALLED" ]; then
    "$INSTALLED" --version
else
    if [ -n "$FOUND" ]; then
        # Another semantius comes first on PATH: running "semantius" starts
        # that one, not the binary just installed.
        echo -e "${YELLOW}Warning: another semantius comes first on your PATH and shadows the one just installed:${NC}"
        echo "  found on PATH:  $FOUND"
        echo "  just installed: $INSTALLED"
        if [ -n "$ON_PATH" ]; then
            echo "Remove the other one, or put $INSTALL_DIR ahead of its directory on your PATH."
        else
            echo "Remove the other one, and add $INSTALL_DIR to your PATH as shown below."
        fi
        echo ""
    fi

    if [ -z "$ON_PATH" ]; then
        # Not on PATH - show setup instructions for the directory installed into,
        # written with $HOME when it is under it, as a shell startup file has it
        case "$INSTALL_DIR" in
            "$HOME"/*) PATH_DIR="\$HOME/${INSTALL_DIR#"$HOME"/}" ;;
            *) PATH_DIR="$INSTALL_DIR" ;;
        esac

        echo -e "${YELLOW}Add $INSTALL_DIR to your PATH:${NC}"
        echo ""

        SHELL_NAME=$(basename "${SHELL:-sh}")
        case "$SHELL_NAME" in
            bash)
                echo "  echo 'export PATH=\"$PATH_DIR:\$PATH\"' >> ~/.bashrc"
                echo "  source ~/.bashrc"
                ;;
            zsh)
                echo "  echo 'export PATH=\"$PATH_DIR:\$PATH\"' >> ~/.zshrc"
                echo "  source ~/.zshrc"
                ;;
            fish)
                echo "  fish_add_path \"$PATH_DIR\""
                ;;
            *)
                echo "  export PATH=\"$PATH_DIR:\$PATH\""
                ;;
        esac
        echo ""
    fi
fi

echo "Get started:"
echo "  semantius --help"
echo ""
