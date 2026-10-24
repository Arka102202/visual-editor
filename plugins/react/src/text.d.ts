// Markdown files imported as text (the build's loader), e.g. the variant rules for the assistant skill.
declare module '*.md' {
  const text: string;
  export default text;
}
