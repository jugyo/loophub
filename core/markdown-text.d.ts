// Bun's bundler embeds `import x from "./y.md" with { type: "text" }` into the compiled binary,
// so a skill or document shipped as Markdown travels with the executable. @types/bun declares the
// other text-like extensions but not .md.
declare module "*.md" {
  const content: string;
  export default content;
}
