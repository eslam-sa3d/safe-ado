/** Browser preview of the hub against the in-memory fake backend (not shipped in the VSIX). */
const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

module.exports = {
  mode: "development",
  devtool: false,
  entry: { preview: "./preview/preview.tsx" },
  output: { path: path.resolve(__dirname, "preview-dist"), filename: "[name].js", clean: true },
  resolve: {
    extensions: [".ts", ".tsx", ".js"],
    alias: {
      "azure-devops-extension-sdk": path.resolve(__dirname, "test/sdkMock.ts"),
      vitest: path.resolve(__dirname, "preview/vitest-shim.ts"),
    },
  },
  module: {
    rules: [
      { test: /\.tsx?$/, loader: "ts-loader", options: { transpileOnly: true }, exclude: /node_modules/ },
      { test: /\.css$/, use: ["style-loader", "css-loader"] },
      { test: /\.(woff2?|ttf)$/, type: "asset/inline" },
    ],
  },
  plugins: [new CopyPlugin({ patterns: [{ from: "preview/index.html", to: "index.html" }] })],
  performance: { hints: false },
};
