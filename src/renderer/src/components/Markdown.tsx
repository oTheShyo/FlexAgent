import { memo, useDeferredValue, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

export interface MarkdownProps {
  content: string
  streaming?: boolean
}

function CodeBlock({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement> & { children?: ReactNode }): ReactElement {
  const match = /language-(\S+)/.exec(className ?? '')
  return (
    <pre
      className="overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] p-3 font-mono text-xs leading-5 text-[var(--text)]"
      data-lang={match?.[1] || undefined}
      {...props}
    >
      <code className={className}>{children}</code>
    </pre>
  )
}

function InlineCode({ className, children, ...props }: React.HTMLAttributes<HTMLElement>): ReactElement {
  return (
    <code
      className={`rounded bg-[var(--surface-raised)] px-1 py-0.5 font-mono text-[0.85em] text-[var(--text)] ${className ?? ''}`}
      {...props}
    >
      {children}
    </code>
  )
}

const markdownComponents = {
  pre: ({ children, ...props }: React.HTMLAttributes<HTMLElement> & { children?: ReactNode }) => {
    void props
    return <>{children}</>
  },
  code: ({
    className,
    children,
    ...props
  }: React.HTMLAttributes<HTMLElement> & { children?: ReactNode }) => {
    const langMatch = /language-(\S+)/.exec(className ?? '')
    const text = typeof children === 'string' ? children : ''
    const isBlock = langMatch !== null || text.includes('\n')
    if (isBlock) {
      return (
        <CodeBlock className={className} {...props}>
          {children}
        </CodeBlock>
      )
    }
    return (
      <InlineCode className={className} {...props}>
        {children}
      </InlineCode>
    )
  },
  a: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-[var(--accent)] underline underline-offset-2 hover:opacity-80"
      {...props}
    >
      {children}
    </a>
  ),
  table: ({ children, ...props }: React.HTMLAttributes<HTMLTableElement>) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...props}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...props }: React.HTMLAttributes<HTMLTableCellElement>) => (
    <th
      className="border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1 text-left font-semibold text-[var(--text)]"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }: React.HTMLAttributes<HTMLTableCellElement>) => (
    <td className="border border-[var(--border)] px-2 py-1 text-[var(--text-secondary)]" {...props}>
      {children}
    </td>
  ),
  ul: ({ children, ...props }: React.HTMLAttributes<HTMLUListElement>) => (
    <ul className="list-disc space-y-1 pl-5 marker:text-[var(--text-muted)]" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }: React.HTMLAttributes<HTMLOListElement>) => (
    <ol className="list-decimal space-y-1 pl-5 marker:text-[var(--text-muted)]" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }: React.HTMLAttributes<HTMLLIElement>) => (
    <li className="text-sm leading-6 text-[var(--text)]" {...props}>
      {children}
    </li>
  ),
  p: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p className="whitespace-pre-wrap text-sm leading-6 text-[var(--text)]" {...props}>
      {children}
    </p>
  ),
  h1: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h1 className="mt-4 mb-2 text-lg font-semibold tracking-tight text-[var(--text)] first:mt-0" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 className="mt-4 mb-2 text-base font-semibold tracking-tight text-[var(--text)] first:mt-0" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3 className="mt-3 mb-1.5 text-sm font-semibold text-[var(--text)] first:mt-0" {...props}>
      {children}
    </h3>
  ),
  h4: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h4 className="mt-3 mb-1.5 text-sm font-semibold text-[var(--text-secondary)] first:mt-0" {...props}>
      {children}
    </h4>
  ),
  blockquote: ({ children, ...props }: React.HTMLAttributes<HTMLQuoteElement>) => (
    <blockquote
      className="border-l-2 border-[var(--border-strong)] pl-3 text-sm italic text-[var(--text-secondary)]"
      {...props}
    >
      {children}
    </blockquote>
  ),
  hr: (props: React.HTMLAttributes<HTMLHRElement>) => (
    <hr className="my-4 border-[var(--border)]" {...props} />
  ),
  strong: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <strong className="font-semibold text-[var(--text)]" {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <em {...props}>{children}</em>
  ),
  input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input type="checkbox" disabled className="mr-1.5 align-middle" {...props} />
  )
}

export const Markdown = memo(function Markdown({
  content,
  streaming = false
}: MarkdownProps): ReactElement {
  const deferred = useDeferredValue(content)
  const source = streaming ? deferred : content

  return (
    <div className="space-y-3" data-md-root>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={markdownComponents}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
})

export default Markdown
