import { useState } from 'react';
import { api, errorText, unwrap } from '../api';
import { useApp } from '../store';
import Popover from './Popover';

interface AlbumMenuProps {
  photoIds: number[];
  x: number;
  y: number;
  placement?: 'below' | 'above';
  onClose: () => void;
}

export default function AlbumMenu({ photoIds, x, y, placement = 'below', onClose }: AlbumMenuProps) {
  const albums = useApp((s) => s.albums);
  const refreshAlbums = useApp((s) => s.refreshAlbums);
  const showToast = useApp((s) => s.showToast);
  const bumpData = useApp((s) => s.bumpData);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async (albumId: number, albumName: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await unwrap(api.album.addPhotos(albumId, photoIds));
      await refreshAlbums();
      bumpData();
      showToast(r.added > 0 ? `已加入「${albumName}」${r.added} 张` : '这些照片已在相册里');
      onClose();
    } catch (e) {
      showToast(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const createAndAdd = async (): Promise<void> => {
    const value = name.trim();
    if (!value) {
      setCreating(false);
      return;
    }
    try {
      const album = await unwrap(api.album.create({ name: value, photoIds }));
      setName('');
      setCreating(false);
      await refreshAlbums();
      bumpData();
      showToast(`已新建「${album.name}」并放入 ${photoIds.length} 张`);
      onClose();
    } catch (e) {
      showToast(errorText(e));
    }
  };

  const manual = albums.filter((a) => a.kind === 'manual');

  return (
    <Popover x={x} y={y} width={252} placement={placement} onClose={onClose}>
      <div className="popover-head">
        加入相册
        <span className="sub">{photoIds.length} 张</span>
      </div>
      <div className="popover-list">
        {manual.length === 0 && <div className="popover-empty">还没有手动相册，下面新建一个</div>}
        {manual.map((album) => (
          <button
            key={album.id}
            className="popover-item"
            disabled={busy}
            onClick={() => void add(album.id, album.name)}
          >
            <span className="tag-name">{album.name}</span>
            <span className="tag-count">{album.photoCount}</span>
          </button>
        ))}
      </div>
      <div className="popover-foot">
        {creating ? (
          <input
            className="select"
            autoFocus
            placeholder="相册名，回车确认"
            value={name}
            style={{ width: '100%' }}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createAndAdd();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setCreating(false);
              }
            }}
            onBlur={() => setCreating(false)}
          />
        ) : (
          <button className="link-btn" onClick={() => setCreating(true)}>
            + 新建相册
          </button>
        )}
      </div>
    </Popover>
  );
}
