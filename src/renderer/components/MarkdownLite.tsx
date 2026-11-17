import type { ReactNode } from 'react';
import { api } from '../api';

/**
 * 只管「发布说明」这一种场景的极简 Markdown。
 *
 * GitHub Release 的正文是 Markdown，直接按纯文本展示会看到一堆 `##`、`*`、`<sup>`。
 * 完整解析器（marked / markdown-it）为一个弹窗引入几十 KB 不值当，这里只认
 * 标题、无序列表、分割线、粗体、行内代码和链接——发布说明里 99% 就这些。
 * 段落用 React 元素拼，不碰 innerHTML，Release 正文里的 HTML 标签一律剥掉。
 */

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, '');
}

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((?:[^)\s]+)\)/g;
  let last = 0;
  let seq = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text))) {
    if (m.index > last) out.push(stripTags(text.slice(last, m.index)));
    const token = m[0];
    const key = `${keyBase}-${seq++}`;

    if (token.startsWith('**')) {
      out.push(<strong key={key}>{stripTags(token.slice(2, -2))}</strong>);
    } else if (token.startsWith('`')) {
      out.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (link) {
        const href = link[2];
        out.push(
          <a
            key={key}
            href={href}
            onClick={(e) => {
              // 让系统浏览器打开，别在应用窗口里跳走
              e.preventDefault();
              void api.app.openExternal(href);
            }}
          >
            {stripTags(link[1])}
          </a>
        );
      } else {
        out.push(stripTags(token));
      }
    }
    last = m.index + token.length;
  }

  if (last < text.length) out.push(stripTags(text.slice(last)));
  return out;
}

export default function MarkdownLite({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let seq = 0;

  const flushList = (): void => {
    if (!list.length) return;
    const key = `ul-${seq++}`;
    blocks.push(
      <ul key={key}>
        {list.map((item, i) => (
          <li key={i}>{inline(item, `${key}-${i}`)}</li>
        ))}
      </ul>
    );
    list = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      list.push(bullet[1]);
      continue;
    }

    flushList();
    if (!line.trim()) continue;

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(
        <div key={`h-${seq++}`} className={`md-h md-h${level}`}>
          {inline(heading[2], `h-${seq}`)}
        </div>
      );
      continue;
    }

    if (/^-{3,}$/.test(line.trim())) {
      blocks.push(<hr key={`hr-${seq++}`} />);
      continue;
    }

    blocks.push(<p key={`p-${seq++}`}>{inline(line, `p-${seq}`)}</p>);
  }
  flushList();

  return <div className="md">{blocks}</div>;
}
