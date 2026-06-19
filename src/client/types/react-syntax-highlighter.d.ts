// Ambient type declarations for `react-syntax-highlighter`.
// The package ships no bundled types and `@types/react-syntax-highlighter`
// is not installed, so we declare the small surface this app actually uses.

declare module "react-syntax-highlighter" {
  import type { ComponentType, CSSProperties, ReactNode } from "react";

  export interface SyntaxHighlighterProps {
    language?: string;
    style?: { [key: string]: CSSProperties };
    showLineNumbers?: boolean;
    wrapLongLines?: boolean;
    customStyle?: CSSProperties;
    codeTagProps?: Record<string, unknown>;
    PreTag?: string | ComponentType<unknown>;
    CodeTag?: string | ComponentType<unknown>;
    className?: string;
    children?: ReactNode;
    [key: string]: unknown;
  }

  export const Prism: ComponentType<SyntaxHighlighterProps>;
  export const Light: ComponentType<SyntaxHighlighterProps>;

  const SyntaxHighlighter: ComponentType<SyntaxHighlighterProps>;
  export default SyntaxHighlighter;
}

declare module "react-syntax-highlighter/dist/esm/styles/prism" {
  import type { CSSProperties } from "react";

  type PrismStyle = { [key: string]: CSSProperties };

  export const oneDark: PrismStyle;
  export const oneLight: PrismStyle;

  const styles: { [key: string]: PrismStyle };
  export default styles;
}
