'use client'

import { useState } from 'react'
import type { ChatProductActionsProps } from '@/modules/chat/lib/slots'
import { addToCart } from '@/modules/shop/components/public/cart'
import { addToCartOptions, basketMetaFor } from '@/modules/ai-agent-for-live-chat/lib/basket-add'
import { AiChatStyles } from './styles'

// Under a message drawn with product cards, in the visitor's chat window
// (Live Chat's `chat.product-actions` slot): "Add to basket" for each product
// the shop can add as it stands, "Add all" when there are two or more, and
// "Choose options" for anything that needs a choice made first (a range, or a
// product with options still to pick), which opens the product's own page.
//
// Nothing goes in the basket without a click. Each add goes through the shop's
// own basket code, exactly as the shop's own button would, so the basket
// drawer, the counter and a signed-in shopper's other devices all hear of it;
// the shop checks price and stock again at checkout, as it always does.
//
// A card that names the delivery service the visitor chose (`delivery.key`)
// goes in with that service already picked: the line meta the shop's own basket
// picker would write is asked for once, on the click (lib/basket-add.ts). Any
// failure there adds the product without the service, never not at all.

type Product = ChatProductActionsProps['products'][number]

function addable(product: Product): product is Product & { basket: { productId: string; listingId: string; needsChoice: false } } {
  return !!product.basket && !product.basket.needsChoice && !!product.basket.productId
}

export function ProductButtons({ products }: ChatProductActionsProps) {
  const [added, setAdded] = useState<ReadonlySet<string>>(() => new Set())
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  if (products.length === 0) return null

  const ready = products.filter(addable)
  const add = async (list: readonly Product[]) => {
    const going = list.filter(addable).filter((p) => !busy.has(p.url))
    if (going.length === 0) return
    const urls = going.map((p) => p.url)
    setBusy((prev) => new Set([...prev, ...urls]))
    const metas = await Promise.all(going.map((p) => basketMetaFor(p.basket.productId, p)))
    going.forEach((product, i) => addToCart(product.basket.productId, 1, addToCartOptions(metas[i] ?? null)))
    setAdded((prev) => new Set([...prev, ...urls]))
    setBusy((prev) => new Set([...prev].filter((url) => !urls.includes(url))))
  }
  const allAdded = ready.length > 0 && ready.every((p) => added.has(p.url))
  const many = products.length > 1

  return (
    <div className="aic-basket">
      <AiChatStyles />
      {products.map((product) => {
        const label = many ? ` ${product.name}` : ''
        if (!addable(product)) {
          return (
            <a key={product.url} href={product.url}>
              Choose options{label}
            </a>
          )
        }
        return added.has(product.url) ? (
          <span key={product.url} className="aic-added" role="status">Added{label}</span>
        ) : (
          <button key={product.url} type="button" disabled={busy.has(product.url)} onClick={() => void add([product])}>
            Add to basket{label}
          </button>
        )
      })}
      {ready.length >= 2 && !allAdded ? (
        <button type="button" disabled={busy.size > 0} onClick={() => void add(ready.filter((p) => !added.has(p.url)))}>Add all</button>
      ) : null}
    </div>
  )
}
