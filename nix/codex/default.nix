{
  flake-utils,
  nixpkgs,
  ...
}:
let
  systems = [
    "aarch64-darwin"
    "x86_64-darwin"
    "aarch64-linux"
    "x86_64-linux"
  ];
in
flake-utils.lib.eachSystem systems (
  system:
  let
    pkgs = import nixpkgs { inherit system; };
    version = "0.172.0";
    platform =
      {
        aarch64-darwin = {
          npm = "darwin-arm64";
          hash = "sha256-SdtPFp7LaSIrS8IHSOO3HrjYMQ3El1YLTuMmLLB23lE=";
        };
        x86_64-darwin = {
          npm = "darwin-x64";
          hash = "sha256-rhk4vpFfahKu2tEmpiLZdEgGXQ6aV8lPHvgYI0lbI9M=";
        };
        aarch64-linux = {
          npm = "linux-arm64";
          hash = "sha256-Qm85pbYgCuZwahN6FBkSyOu9vfxiAhmZ1oHB/TmSiio=";
        };
        x86_64-linux = {
          npm = "linux-x64";
          hash = "sha256-SKXuXbqYx3RaSLjXKvhPkYgP7FhWJpYnMo/VZPYNQac=";
        };
      }
      .${system};
    src = pkgs.fetchurl {
      url = "https://registry.npmjs.org/@openai/codex/-/codex-${version}-${platform.npm}.tgz";
      hash = platform.hash;
    };
  in
  {
    packages.codex =
      pkgs.runCommand "codex-${version}"
        {
          pname = "codex";
          inherit src version;
        }
        ''
          tar -xzf "$src"
          # Keep the package metadata and bundled resources beside bin for discovery.
          mkdir -p "$out"
          cp -R package/vendor/*/. "$out/"
        '';
  }
)
