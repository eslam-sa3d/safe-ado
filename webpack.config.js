const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

module.exports = (env, argv) => ({
  entry: { hub: "./src/hub/hub.tsx", form: "./src/form/form.tsx" },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].js",
    clean: true,
  },
  // Source maps only in dev; the VSIX should stay small.
  devtool: argv.mode === "development" ? "inline-source-map" : false,
  resolve: { extensions: [".ts", ".tsx", ".js"] },
  module: {
    rules: [
      { test: /\.tsx?$/, loader: "ts-loader", exclude: /node_modules/ },
      { test: /\.css$/, use: ["style-loader", "css-loader"] },
      // Subsetted Fluent icon fonts (~7 KB) are inlined into the bundle.
      { test: /\.woff2$/, type: "asset/inline" },
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: "src/hub/hub.html", to: "hub.html" },
        { from: "src/form/form.html", to: "form.html" },
      ],
    }),
  ],
  performance: { hints: false },
});
