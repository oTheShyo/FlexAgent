import { memo, useDeferredValue, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

export interface MarkdownProps {
  content: string
  streaming?: boolean
}

type MdProps<T> = T & { node?: unknown }

function omitNode<T extends object>(props: MdProps<T>): T {
  const { node: _node, ...rest } = props
  void _node
  return rest as T
}

function CodeBlock({
  className,
  children
}: {
  className?: string
  children?: ReactNode
}): ReactElement {
  const match = /language-(\S+)/.exec(className ?? '')
  return (
    <pre
      className="overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] p-3 font-mono text-xs leading-5 text-[var(--text)]"
      data-lang={match?.[1] || undefined}
    >
      <code className={className}>{children}</code>
    </pre>
  )
}

function InlineCode({
  className,
  children
}: {
  className?: string
  children?: ReactNode
}): ReactElement {
  return (
    <code
      className={`rounded bg-[var(--surface-raised)] px-1 py-0.5 font-mono text-[0.85em] text-[var(--text)] ${className ?? ''}`}
    >
      {children}
    </code>
  )
}

const markdownComponents = {
  pre: ({ children }: MdProps<{ children?: ReactNode }>) => <>{children}</>,
  code: (props: MdProps<{ className?: string; children?: ReactNode }>) => {
    const { className, children } = omitNode(props)
    const langMatch = /language-(\S+)/.exec(className ?? '')
    const text = typeof children === 'string' ? children : ''
    const isBlock = langMatch !== null || text.includes('\n')
    if (isBlock) {
      return (
        <CodeBlock className={className}>
          {children}
        </CodeBlock>
      )
    }
    return (
      <InlineCode className={className}>
        {children}
      </InlineCode>
    )
  },
  a: (props: MdProps<React.AnchorHTMLAttributes<HTMLAnchorElement>>) => {
    const { children, href, ...rest } = omitNode(props)
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="text-[var(--accent)] underline underline-offset-2 hover:opacity-80"
        {...rest}
      >
        {children}
      </a>
    )
  },
  table: (props: MdProps<React.HTMLAttributes<HTMLTableElement>>) => {
    const { children, ...rest } = omitNode(props)
    return (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm" {...rest}>
          {children}
        </table>
      </div>
    )
  },
  th: (props: MdProps<React.HTMLAttributes<HTMLTableCellElement>>) => {
    const { children, ...rest } = omitNode(props)
    return (
      <th
        className="border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1 text-left font-semibold text-[var(--text)]"
        {...rest}
      >
        {children}
      </th>
    )
  },
  td: (props: MdProps<React.HTMLAttributes<HTMLTableCellElement>>) => {
    const { children, ...rest } = omitNode(props)
    return (
      <td className="border border-[var(--border)] px-2 py-1 text-[var(--text-secondary)]" {...rest}>
        {children}
      </td>
    )
  },
  ul: (props: MdProps<React.HTMLAttributes<HTMLUListElement>>) => {
    const { children, ...rest } = omitNode(props)
    return (
      <ul className="list-disc space-y-1 pl-5 marker:text-[var(--text-muted)]" {...rest}>
        {children}
      </ul>
    )
  },
  ol: (props: MdProps<React.HTMLAttributes<HTMLOListElement>>) => {
    const { children, ...rest } = omitNode(props)
    return (
      <ol className="list-decimal space-y-1 pl-5 marker:text-[var(--text-muted)]" {...rest}>
        {children}
      </ol>
    )
  },
  li: (props: MdProps<React.HTMLAttributes<HTMLLIElement>>) => {
    const { children, ...rest } = omitNode(props)
    return (
      <li className="text-sm leading-6 text-[var(--text)]" {...rest}>
        {children}
      </li>
    )
  },
  p: (props: MdProps<React.HTMLAttributes<HTMLParagraphElement>>) => {
    const { children, ...rest } = omitNode(props)
    return (
      <p className="whitespace-pre-wrap text-sm leading-6 text-[var(--text)]" {...rest}>
        {children}
      </p>
    )
  },
  h1: (props: MdProps<React.HTMLAttributes<HTMLHeadingElement>>) => {
    const { children, ...rest } = omitNode(props)
    return (
      <h1 className="mt-4 mb-2 text-lg font-semibold tracking-tight text-[var(--text)] first:mt-0" {...rest}>
        {children}
      </h1>
    )
  },
  h2: (props: MdProps<React.HTMLAttributes<HTMLHeadingElement>>) => {
    const { children, ...rest } = omitNode(props)
    return (
      <h2 className="mt-4 mb-2 text-base font-semibold tracking-tight text-[var(--text)] first:mt-0" {...rest}>
        {children}
      </h2>
    )
  },
  h3: (props: MdProps<React.HTMLAttributes<HTMLHeadingElement>>) => {
    const { children, ...rest } = omitNode(props)
    return (
      <h3 className="mt-3 mb-1.5 text-sm font-semibold text-[var(--text)] first:mt-0" {...rest}>
        {children}
      </h3>
    )
  },
  h4: (props: MdProps<React.HTMLAttributes<HTMLHeadingElement>>) => {
    const { children, ...rest } = omitNode(props)
    return (
      <h4 className="mt-3 mb-1.5 text-sm font-semibold text-[var(--text-secondary)] first:mt-0" {...rest}>
        {children}
      </h4>
    )
  },
  blockquote: (props: MdProps<React.HTMLAttributes<HTMLQuoteElement>>) => {
    const { children, ...rest } = omitNode(props)
    return (
      <blockquote
        className="border-l-2 border-[var(--border-strong)] pl-3 text-sm italic text-[var(--text-secondary)]"
        {...rest}
      >
        {children}
      </blockquote>
    )
  },
  hr: (props: MdProps<React.HTMLAttributes<HTMLHRElement>>) => {
    const rest = omitNode(props)
    return <hr className="my-4 border-[var(--border)]" {...rest} />
  },
  strong: (props: MdProps<React.HTMLAttributes<HTMLElement>>) => {
    const { children, ...rest } = omitNode(props)
    return (
      <strong className="font-semibold text-[var(--text)]" {...rest}>
        {children}
      </strong>
    )
  },
  em: (props: MdProps<React.HTMLAttributes<HTMLElement>>) => {
    const { children, ...rest } = omitNode(props)
    return <em {...rest}>{children}</em>
  },
  input: (props: MdProps<React.InputHTMLAttributes<HTMLInputElement>>) => {
    const rest = omitNode(props)
    return <input type="checkbox" disabled className="mr-1.5 align-middle" {...rest} />
  }
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
