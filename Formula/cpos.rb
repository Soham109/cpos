class Cpos < Formula
  desc "Competitive Programming Operating System terminal app"
  homepage "https://github.com/Soham109/cpos"
  version "0.3.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/Soham109/cpos/releases/download/v0.3.0/cpos-aarch64-apple-darwin.tar.gz"
      sha256 "c78bdfecb2eea915b097621da11161c4bb7dd4106c569c757faf8cf7b6317eaf"
    end

    on_intel do
      url "https://github.com/Soham109/cpos/releases/download/v0.3.0/cpos-x86_64-apple-darwin.tar.gz"
      sha256 "bd89deeba75555f544ad42c10a60fef81c80bf053c6edd9f26234673065dcf03"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/Soham109/cpos/releases/download/v0.3.0/cpos-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "49b33d373dbe28aab227a296db20622a0acccb2a33e8af22b04d1da9e7e96dc2"
    end
  end

  def install
    bin.install "cpos"
  end

  test do
    assert_match "CPOS v0.3.0", shell_output("#{bin}/cpos help 2>&1")
  end
end
