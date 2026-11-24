import type { EmailTemplateDef } from '@/lib/email/registry'

// The emails the chat assistant can send, declared for core's single email
// editor (Settings > Emails, group "Chat assistant"). Core owns the wording,
// the wrapper design and the sending; this file is only the defaults and what
// may be merged in. They leave from the address chosen on this module's
// settings tab (the Unified Inbox's sender for `ai-agent-for-live-chat`).
//
// The order link goes when a visitor who has proved an order asks for its page
// by email. It only ever goes to the address on that order, never to one typed
// in the chat.
//
// The chat note goes when a visitor asks for a written note of what was
// discussed (product advice, mostly), to an address they typed in the chat or
// the one on an order they proved. {{summaryHtml}} and {{productsHtml}} are
// built in code from escaped text and the shop's own product rows.
//
// {{reportIssueUrl}} is the order link with the issue form already open. It is
// empty on a shop that has issue reports switched off, which takes its whole
// {{#if hasReportIssueUrl}} line with it.
//
// Transactional: the customer asked for each one, in the chat, a moment ago.

export const aiAgentForLiveChatEmailTemplates: EmailTemplateDef[] = [
  {
    key: 'ai-agent-for-live-chat.order-link',
    label: 'Order link, asked for in the live chat',
    subject: 'Your order link for {{orderNumber}}',
    bodyHtml:
      '<p>Hi {{customerName}},</p><p>Thanks for getting in touch. As promised in the chat, here is the link to your order <strong>{{orderNumber}}</strong>:</p><p><a href="{{orderUrl}}">{{orderUrl}}</a></p>{{#if hasReportIssueUrl}}<p>If something arrived damaged, <a href="{{reportIssueUrl}}">use this link to tell us about it</a> and add photos there.</p>{{/if}}<p>If anything is unclear, just reply to this email.</p>',
    mergeTags: ['customerName', 'orderNumber', 'orderUrl', 'reportIssueUrl', 'hasReportIssueUrl', 'siteName'],
    requiredTags: ['orderUrl'],
    transactional: true,
  },
  {
    key: 'ai-agent-for-live-chat.chat-summary',
    label: 'Note of what was discussed in the live chat',
    subject: '{{subject}}',
    bodyHtml:
      '<p>Hi {{customerName}},</p><p>Thanks for chatting with us. As promised, here is a note of what we talked about:</p>{{summaryHtml}}{{#if hasProducts}}<p><strong>The products we mentioned</strong></p>{{productsHtml}}{{/if}}<p>If anything is unclear, just reply to this email.</p>',
    mergeTags: ['customerName', 'subject', 'summaryHtml', 'productsHtml', 'hasProducts', 'siteName'],
    requiredTags: ['summaryHtml'],
    rawTags: ['summaryHtml', 'productsHtml'],
    transactional: true,
  },
]
