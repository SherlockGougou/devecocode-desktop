# typed: strict
# frozen_string_literal: true

cask "devecocode-desktop" do
  version "__VERSION__"

  on_arm do
    sha256 "__SHA256_ARM__"

    url "https://github.com/SherlockGougou/devecocode-desktop/releases/download/v#{version}/DevEco.Code_#{version}_aarch64.dmg"
  end
  on_intel do
    sha256 "__SHA256_INTEL__"

    url "https://github.com/SherlockGougou/devecocode-desktop/releases/download/v#{version}/DevEco.Code_#{version}_x64.dmg"
  end

  name "DevEco Code"
  desc "Desktop client for the DevEco Code CLI"
  homepage "https://sherlockgougou.github.io/devecocode-desktop/"

  livecheck do
    url "https://github.com/SherlockGougou/devecocode-desktop/releases/latest"
    strategy :github_latest
  end

  depends_on macos: :monterey

  app "DevEco Code.app"

  zap trash: [
    "~/Library/Application Support/com.deveco.desktop",
    "~/Library/Application Support/DevEco Code Desktop",
    "~/Library/Caches/com.deveco.desktop",
    "~/Library/HTTPStorages/com.deveco.desktop.binarycookies",
    "~/Library/Logs/DevEco Code Desktop",
    "~/Library/Preferences/com.deveco.desktop.plist",
    "~/Library/WebKit/com.deveco.desktop",
  ]

  caveats <<~EOS
    This build is ad-hoc signed and not notarized by Apple.
    On first launch, right-click the app in Applications and choose Open,
    or use System Settings > Privacy & Security > Open Anyway.
  EOS
end
