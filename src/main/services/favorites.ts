import type { Database } from './database'
import { randomId } from '../util/hash'
import { toFavoriteItem } from './mappers'
import type { FavoriteItem } from '@shared/types'

export class FavoritesService {
  constructor(private db: Database) {}

  isFavorite(itemType: string, itemId: string): boolean {
    if (!validType(itemType)) return false
    return Boolean(
      this.db.get('SELECT id FROM favorites WHERE item_type = ? AND item_id = ?', [
        itemType,
        itemId
      ])
    )
  }

  toggle(itemType: string, itemId: string): boolean {
    if (!validType(itemType)) return false
    const exists = this.isFavorite(itemType, itemId)
    if (exists) {
      this.db.run('DELETE FROM favorites WHERE item_type = ? AND item_id = ?', [itemType, itemId])
      if (itemType === 'song') {
        this.db.run('UPDATE songs SET favorite = 0 WHERE id = ?', [itemId])
      } else if (itemType === 'album') {
        this.db.run('UPDATE albums SET favorite = 0 WHERE id = ?', [itemId])
      } else if (itemType === 'artist') {
        this.db.run('UPDATE artists SET favorite = 0 WHERE id = ?', [itemId])
      } else if (itemType === 'playlist') {
        this.db.run('UPDATE playlists SET favorite = 0 WHERE id = ?', [itemId])
      }
    } else {
      this.db.run(
        'INSERT INTO favorites (id, item_type, item_id, created_at) VALUES (?, ?, ?, ?)',
        [randomId(), itemType, itemId, Date.now()]
      )
      if (itemType === 'song') {
        this.db.run('UPDATE songs SET favorite = 1 WHERE id = ?', [itemId])
      } else if (itemType === 'album') {
        this.db.run('UPDATE albums SET favorite = 1 WHERE id = ?', [itemId])
      } else if (itemType === 'artist') {
        this.db.run('UPDATE artists SET favorite = 1 WHERE id = ?', [itemId])
      } else if (itemType === 'playlist') {
        this.db.run('UPDATE playlists SET favorite = 1 WHERE id = ?', [itemId])
      }
    }
    return !exists
  }

  list(itemType: string): FavoriteItem[] {
    if (!validType(itemType)) return []
    return this.db
      .all<Record<string, unknown>>(
        'SELECT * FROM favorites WHERE item_type = ? ORDER BY created_at DESC',
        [itemType]
      )
      .map(toFavoriteItem)
  }

  all(): FavoriteItem[] {
    return this.db
      .all<Record<string, unknown>>('SELECT * FROM favorites ORDER BY created_at DESC')
      .map(toFavoriteItem)
  }

  favoriteSongs(): string[] {
    return this.db
      .all<{ item_id: string }>("SELECT item_id FROM favorites WHERE item_type = 'song'")
      .map((r) => r.item_id)
  }
}

function validType(itemType: string): boolean {
  return itemType === 'song' || itemType === 'album' || itemType === 'artist' || itemType === 'playlist'
}