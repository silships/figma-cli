class FigmaDsCli < Formula
  desc "CLI for managing Figma design systems — variables, components, tokens, no API key required"
  homepage "https://github.com/silships/figma-cli"
  url "https://github.com/silships/figma-cli/archive/refs/tags/v2.1.0.tar.gz"
  sha256 "d6a9e4944cb98d38a4c537152cff0046f7e48d007f7fc806c0ad92d1eea8cc4e"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/figma-ds-cli --version")
  end
end
