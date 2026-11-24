'use client'

import { useState } from 'react'
import type { ChatProductActionsProps } from '@/modules/chat/lib/slots'
import { addToCart } from '@/modules/shop/components/public/cart'
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

type Product = ChatProductActionsProps['products'][number]

function addable(product: Product): product is Product & { basket: { productId: string; listingId: string; needsChoice: false } } {
  return !!product.basket && !product.basket.needsChoice && !!product.basket.productId
}

export function ProductButtons({ products }: ChatProductActionsProps) {
  const [added, setAdded] = useState<ReadonlySet<string>>(() => new Set())
  if (products.length === 0) return null

  const ready = products.filter(addable)
  const add = (list: readonly Product[]) => {
    const next = new Set(added)
    for (const product of list) {
      if (!addable(product)) continue
      addToCart(product.basket.productId, 1)
      next.add(product.url)
    }
    setAdded(next)
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
          <button key={product.url} type="button" onClick={() => add([product])}>
            Add to basket{label}
          </button>
        )
      })}
      {ready.length >= 2 && !allAdded ? (
        <button type="button" onClick={() => add(ready.filter((p) => !added.has(p.url)))}>Add all</button>
      ) : null}
    </div>
  )
}
