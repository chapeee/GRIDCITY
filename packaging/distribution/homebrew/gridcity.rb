# Homebrew cask: put this in a tap repository (chapeee/homebrew-tap, file
# Casks/gridcity.rb), then users run `brew install --cask chapeee/tap/gridcity`.
cask "gridcity" do
  arch arm: "arm64", intel: "x64"

  version "{{VERSION}}"
  sha256 arm:   "{{MAC_ARM64_SHA256}}",
         intel: "{{MAC_X64_SHA256}}"

  url "https://github.com/chapeee/GRIDCITY/releases/download/v#{version}/GRIDCITY-#{version}-mac-#{arch}.dmg"
  name "GRIDCITY"
  desc "Servers, databases and buckets as a living 3D city of light"
  homepage "https://chapeee.github.io/GRIDCITY/"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "GRIDCITY.app"

  zap trash: [
    "~/.config/gridcity",
    "~/.local/share/gridcity",
    "~/Library/Application Support/GRIDCITY",
  ]
end
