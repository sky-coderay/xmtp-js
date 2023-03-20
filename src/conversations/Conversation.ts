import {
  buildUserIntroTopic,
  buildDirectMessageTopic,
  dateToNs,
  concat,
  b64Decode,
} from '../utils'
import { utils } from 'ethers'
import Stream from '../Stream'
import Client, {
  ListMessagesOptions,
  ListMessagesPaginatedOptions,
  SendOptions,
} from '../Client'
import { InvitationContext } from '../Invitation'
import { DecodedMessage, MessageV1, MessageV2, decodeContent } from '../Message'
import {
  messageApi,
  message,
  content as proto,
  keystore,
  ciphertext,
} from '@xmtp/proto'
import {
  SignedPublicKey,
  Signature,
  PublicKeyBundle,
  SignedPublicKeyBundle,
} from '../crypto'
import { sha256 } from '../crypto/encryption'
import { ContentTypeText } from '../codecs/Text'
import { buildDecryptV1Request, getResultOrThrow } from '../utils/keystore'

/**
 * Conversation class allows you to view, stream, and send messages to/from a peer address
 */
export class ConversationV1 {
  peerAddress: string
  createdAt: Date
  context = null
  private client: Client

  constructor(client: Client, address: string, createdAt: Date) {
    this.peerAddress = utils.getAddress(address)
    this.client = client
    this.createdAt = createdAt
  }

  /**
   * Returns a list of all messages to/from the peerAddress
   */
  async messages(opts?: ListMessagesOptions): Promise<DecodedMessage[]> {
    const topic = buildDirectMessageTopic(this.peerAddress, this.client.address)
    const messages = await this.client.listEnvelopes(
      [topic],
      this.processEnvelope.bind(this),
      opts
    )

    return this.decryptBatch(messages, topic, false)
  }

  messagesPaginated(
    opts?: ListMessagesPaginatedOptions
  ): AsyncGenerator<DecodedMessage[]> {
    return this.client.listEnvelopesPaginated(
      [this.topic],
      // This won't be performant once we start supporting a remote keystore
      // TODO: Either better batch support or we ditch this under-utilized feature
      this.decodeMessage.bind(this),
      opts
    )
  }

  // decodeMessage takes an envelope and either returns a `DecodedMessage` or throws if an error occurs
  async decodeMessage(env: messageApi.Envelope): Promise<DecodedMessage> {
    if (!env.contentTopic) {
      throw new Error('Missing content topic')
    }
    const msg = await this.processEnvelope(env)
    const decryptResults = await this.decryptBatch(
      [msg],
      env.contentTopic,
      true
    )
    if (!decryptResults.length) {
      throw new Error('No results')
    }
    return decryptResults[0]
  }

  get topic(): string {
    return buildDirectMessageTopic(this.peerAddress, this.client.address)
  }

  /**
   * Returns a Stream of any new messages to/from the peerAddress
   */
  streamMessages(): Promise<Stream<DecodedMessage>> {
    return Stream.create<DecodedMessage>(
      this.client,
      [this.topic],
      async (env: messageApi.Envelope) => this.decodeMessage(env)
    )
  }

  async processEnvelope({
    message,
    contentTopic,
  }: messageApi.Envelope): Promise<MessageV1> {
    const messageBytes = b64Decode(message as unknown as string)
    const decoded = await MessageV1.fromBytes(messageBytes)
    const { senderAddress, recipientAddress } = decoded

    // Filter for topics
    if (
      !senderAddress ||
      !recipientAddress ||
      !contentTopic ||
      buildDirectMessageTopic(senderAddress, recipientAddress) !== this.topic
    ) {
      throw new Error('Headers do not match intended recipient')
    }

    return decoded
  }

  /**
   * Send a message into the conversation
   */
  async send(
    content: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    options?: SendOptions
  ): Promise<DecodedMessage> {
    let topics: string[]
    let recipient = await this.client.getUserContact(this.peerAddress)
    if (!recipient) {
      throw new Error(`recipient ${this.peerAddress} is not registered`)
    }
    if (!(recipient instanceof PublicKeyBundle)) {
      recipient = recipient.toLegacyBundle()
    }

    if (!this.client.contacts.has(this.peerAddress)) {
      topics = [
        buildUserIntroTopic(this.peerAddress),
        buildUserIntroTopic(this.client.address),
        this.topic,
      ]
      this.client.contacts.add(this.peerAddress)
    } else {
      topics = [this.topic]
    }
    const contentType = options?.contentType || ContentTypeText
    const payload = await this.client.encodeContent(content, options)
    const msg = await this.createMessage(payload, recipient, options?.timestamp)

    await this.client.publishEnvelopes(
      topics.map((topic) => ({
        contentTopic: topic,
        message: msg.toBytes(),
        timestamp: msg.sent,
      }))
    )

    return DecodedMessage.fromV1Message(
      msg,
      content,
      contentType,
      payload,
      topics[0], // Just use the first topic for the returned value
      this
    )
  }

  async decryptBatch(
    messages: MessageV1[],
    topic: string,
    throwOnError = false
  ): Promise<DecodedMessage[]> {
    const responses = (
      await this.client.keystore.decryptV1(
        buildDecryptV1Request(messages, this.client.publicKeyBundle)
      )
    ).responses

    const out: DecodedMessage[] = []
    for (let i = 0; i < responses.length; i++) {
      const result = responses[i]
      const message = messages[i]
      try {
        const { decrypted } = getResultOrThrow(result)
        out.push(await this.buildDecodedMessage(message, decrypted, topic))
      } catch (e) {
        if (throwOnError) {
          throw e
        }
        console.warn('Error decoding content', e)
      }
    }

    return out
  }

  private async buildDecodedMessage(
    message: MessageV1,
    decrypted: Uint8Array,
    topic: string
  ): Promise<DecodedMessage> {
    const { content, contentType, error } = await decodeContent(
      decrypted,
      this.client
    )
    return DecodedMessage.fromV1Message(
      message,
      content,
      contentType,
      decrypted,
      topic,
      this,
      error
    )
  }

  private async createMessage(
    // Payload is expected to be the output of `client.encodeContent`
    payload: Uint8Array,
    recipient: PublicKeyBundle,
    timestamp?: Date
  ): Promise<MessageV1> {
    timestamp = timestamp || new Date()

    return MessageV1.encode(
      this.client.keystore,
      payload,
      this.client.publicKeyBundle,
      recipient,
      timestamp
    )
  }

  get clientAddress() {
    return this.client.address
  }
}

export class ConversationV2 {
  client: Client
  topic: string
  peerAddress: string
  createdAt: Date
  context?: InvitationContext

  constructor(
    client: Client,
    topic: string,
    peerAddress: string,
    createdAt: Date,
    context: InvitationContext | undefined
  ) {
    this.topic = topic
    this.createdAt = createdAt
    this.context = context
    this.client = client
    this.peerAddress = peerAddress
  }

  get clientAddress() {
    return this.client.address
  }

  /**
   * Returns a list of all messages to/from the peerAddress
   */
  async messages(opts?: ListMessagesOptions): Promise<DecodedMessage[]> {
    const messages = await this.client.listEnvelopes(
      [this.topic],
      this.processEnvelope.bind(this),
      opts
    )

    return this.decryptBatch(messages, false)
  }

  messagesPaginated(
    opts?: ListMessagesPaginatedOptions
  ): AsyncGenerator<DecodedMessage[]> {
    return this.client.listEnvelopesPaginated(
      [this.topic],
      this.decodeMessage.bind(this),
      opts
    )
  }

  /**
   * Returns a Stream of any new messages to/from the peerAddress
   */
  streamMessages(): Promise<Stream<DecodedMessage>> {
    return Stream.create<DecodedMessage>(
      this.client,
      [this.topic],
      this.decodeMessage.bind(this)
    )
  }

  /**
   * Send a message into the conversation
   */
  async send(
    content: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    options?: SendOptions
  ): Promise<DecodedMessage> {
    const payload = await this.client.encodeContent(content, options)
    const msg = await this.createMessage(payload, options?.timestamp)
    await this.client.publishEnvelopes([
      {
        contentTopic: this.topic,
        message: msg.toBytes(),
        timestamp: msg.sent,
      },
    ])
    const contentType = options?.contentType || ContentTypeText

    return DecodedMessage.fromV2Message(
      msg,
      content,
      contentType,
      this.topic,
      payload,
      this,
      this.client.address
    )
  }

  async createMessage(
    // Payload is expected to have already gone through `client.encodeContent`
    payload: Uint8Array,
    timestamp?: Date
  ): Promise<MessageV2> {
    const header: message.MessageHeaderV2 = {
      topic: this.topic,
      createdNs: dateToNs(timestamp || new Date()),
    }
    const headerBytes = message.MessageHeaderV2.encode(header).finish()
    const digest = await sha256(concat(headerBytes, payload))
    const signed = {
      payload,
      sender: this.client.signedPublicKeyBundle,
      signature: await this.client.keystore.signDigest({
        digest,
        prekeyIndex: 0,
        identityKey: undefined,
      }),
    }
    const signedBytes = proto.SignedContent.encode(signed).finish()

    const ciphertext = await this.encryptMessage(signedBytes, headerBytes)
    const protoMsg = {
      v1: undefined,
      v2: { headerBytes, ciphertext },
    }
    const bytes = message.Message.encode(protoMsg).finish()

    return MessageV2.create(protoMsg, header, bytes)
  }

  private async decryptBatch(
    messages: MessageV2[],
    throwOnError = false
  ): Promise<DecodedMessage[]> {
    const responses = (
      await this.client.keystore.decryptV2(this.buildDecryptRequest(messages))
    ).responses

    const out: DecodedMessage[] = []
    for (let i = 0; i < responses.length; i++) {
      const result = responses[i]
      const message = messages[i]

      try {
        const { decrypted } = getResultOrThrow(result)
        out.push(await this.buildDecodedMessage(message, decrypted))
      } catch (e) {
        if (throwOnError) {
          throw e
        }
        console.warn('Error decoding content', e)
      }
    }

    return out
  }

  private buildDecryptRequest(
    messages: message.MessageV2[]
  ): keystore.DecryptV2Request {
    return {
      requests: messages.map((m) => {
        return {
          payload: m.ciphertext,
          headerBytes: m.headerBytes,
          contentTopic: this.topic,
        }
      }),
    }
  }

  private async encryptMessage(
    payload: Uint8Array,
    headerBytes: Uint8Array
  ): Promise<ciphertext.Ciphertext> {
    const { responses } = await this.client.keystore.encryptV2({
      requests: [
        {
          payload,
          headerBytes,
          contentTopic: this.topic,
        },
      ],
    })
    if (responses.length !== 1) {
      throw new Error('Invalid response length')
    }
    const { encrypted } = getResultOrThrow(responses[0])
    return encrypted
  }

  private async buildDecodedMessage(
    msg: MessageV2,
    decrypted: Uint8Array
  ): Promise<DecodedMessage> {
    // Decode the decrypted bytes into SignedContent
    const signed = proto.SignedContent.decode(decrypted)
    if (
      !signed.sender?.identityKey ||
      !signed.sender?.preKey ||
      !signed.signature
    ) {
      throw new Error('incomplete signed content')
    }

    await validatePrekeys(signed)

    // Verify the signature
    const digest = await sha256(concat(msg.headerBytes, signed.payload))
    if (
      !new SignedPublicKey(signed.sender?.preKey).verify(
        new Signature(signed.signature),
        digest
      )
    ) {
      throw new Error('invalid signature')
    }

    // Derive the sender address from the valid signature
    const senderAddress = await new SignedPublicKeyBundle(
      signed.sender
    ).walletSignatureAddress()

    const { content, contentType, error } = await decodeContent(
      signed.payload,
      this.client
    )

    return DecodedMessage.fromV2Message(
      msg,
      content,
      contentType,
      this.topic,
      signed.payload,
      this,
      senderAddress,
      error
    )
  }

  async processEnvelope(env: messageApi.Envelope): Promise<MessageV2> {
    if (!env.message || !env.contentTopic) {
      throw new Error('empty envelope')
    }
    const messageBytes = b64Decode(env.message.toString())
    const msg = message.Message.decode(messageBytes)

    if (!msg.v2) {
      throw new Error('unknown message version')
    }

    const header = message.MessageHeaderV2.decode(msg.v2.headerBytes)
    if (header.topic !== this.topic) {
      throw new Error('topic mismatch')
    }

    return MessageV2.create(msg, header, messageBytes)
  }

  async decodeMessage(env: messageApi.Envelope): Promise<DecodedMessage> {
    if (!env.contentTopic) {
      throw new Error('Missing content topic')
    }
    const msg = await this.processEnvelope(env)
    const decryptResults = await this.decryptBatch([msg], true)
    if (!decryptResults.length) {
      throw new Error('No results')
    }
    return decryptResults[0]
  }
}

export type Conversation = ConversationV1 | ConversationV2

async function validatePrekeys(signed: proto.SignedContent) {
  // Check that the pre key is signed by the identity key
  // this is required to chain the prekey-signed message to the identity key
  // and finally to the user's wallet address
  const senderPreKey = signed.sender?.preKey
  if (!senderPreKey || !senderPreKey.signature || !senderPreKey.keyBytes) {
    throw new Error('missing pre-key or pre-key signature')
  }
  const senderIdentityKey = signed.sender?.identityKey
  if (!senderIdentityKey) {
    throw new Error('missing identity key in bundle')
  }
  const isValidPrekey = await new SignedPublicKey(senderIdentityKey).verifyKey(
    new SignedPublicKey(senderPreKey)
  )
  if (!isValidPrekey) {
    throw new Error('pre key not signed by identity key')
  }
}
