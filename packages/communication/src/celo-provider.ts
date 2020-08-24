import {
  Callback,
  EncodedTransaction,
  JsonRpcPayload,
  JsonRpcResponse,
  Provider,
} from '@celo/communication/types/commons'
import debugFactory from 'debug'
import { NodeCommunicationWrapper } from '.'
import { hasProperty, stopProvider } from './utils/provider-utils'
import { rpcCallHandler } from './utils/rpc-caller'

const debug = debugFactory('provider:connection')
const debugPayload = debugFactory('provider:payload')
const debugTxToSend = debugFactory('provider:tx-to-send')
const debugEncodedTx = debugFactory('provider:encoded-tx')
const debugResponse = debugFactory('provider:response')

enum InterceptedMethods {
  accounts = 'eth_accounts',
  sendTransaction = 'eth_sendTransaction',
  signTransaction = 'eth_signTransaction',
  sign = 'eth_sign',
  personalSign = 'personal_sign',
  signTypedData = 'eth_signTypedData',
}

export function assertIsCeloProvider(provider: any): asserts provider is CeloProvider {
  if (!(provider instanceof CeloProvider)) {
    throw new Error(
      'A different Provider was manually added to the kit. The kit should have a CeloProvider'
    )
  }
}

export class CeloProvider implements Provider {
  private alreadyStopped: boolean = false

  constructor(
    readonly existingProvider: Provider,
    readonly communication: NodeCommunicationWrapper
  ) {
    this.addProviderDelegatedFunctions()
  }

  // Used for backwards compatibility. Use the `addAccount` from the NodeCommunicationWrapper
  addAccount(privateKey: string) {
    this.communication.addAccount(privateKey)
  }

  // Used for backwards compatibility. Use the `getAccounts` from the NodeCommunicationWrapper
  async getAccounts(): Promise<string[]> {
    return this.communication.getAccounts()
  }

  // Used for backwards compatibility. Use the `getAccounts` from the NodeCommunicationWrapper
  isLocalAccount(address?: string): boolean {
    return this.communication.wallet != null && this.communication.wallet.hasAccount(address)
  }

  /**
   * Send method as expected by web3.js
   */
  send(payload: JsonRpcPayload, callback: Callback<JsonRpcResponse>): void {
    let txParams: any
    let address: string

    debugPayload('%O', payload)

    const decoratedCallback = (error: Error | null, result?: JsonRpcResponse) => {
      debugResponse('%O', result)
      callback(error, result)
    }

    if (this.alreadyStopped) {
      throw Error('CeloProvider already stopped')
    }

    switch (payload.method) {
      case InterceptedMethods.accounts: {
        rpcCallHandler(payload, this.handleAccounts.bind(this), decoratedCallback)
        return
      }
      case InterceptedMethods.sendTransaction: {
        this.checkPayloadWithAtLeastNParams(payload, 1)
        txParams = payload.params[0]

        if (this.communication.isLocalAccount(txParams.from)) {
          rpcCallHandler(payload, this.handleSendTransaction.bind(this), decoratedCallback)
        } else {
          this.forwardSend(payload, callback)
        }
        return
      }
      case InterceptedMethods.signTransaction: {
        this.checkPayloadWithAtLeastNParams(payload, 1)
        txParams = payload.params[0]

        if (this.communication.isLocalAccount(txParams.from)) {
          rpcCallHandler(payload, this.handleSignTransaction.bind(this), decoratedCallback)
        } else {
          this.forwardSend(payload, callback)
        }
        return
      }
      case InterceptedMethods.sign:
      case InterceptedMethods.personalSign: {
        if (payload.method === InterceptedMethods.sign) {
          this.checkPayloadWithAtLeastNParams(payload, 1)
        } else {
          this.checkPayloadWithAtLeastNParams(payload, 2)
        }
        address = payload.method === InterceptedMethods.sign ? payload.params[0] : payload.params[1]

        if (this.communication.isLocalAccount(address)) {
          rpcCallHandler(payload, this.handleSignPersonalMessage.bind(this), decoratedCallback)
        } else {
          this.forwardSend(payload, callback)
        }

        return
      }
      case InterceptedMethods.signTypedData: {
        this.checkPayloadWithAtLeastNParams(payload, 1)
        address = payload.params[0]

        if (this.communication.isLocalAccount(address)) {
          rpcCallHandler(payload, this.handleSignTypedData.bind(this), decoratedCallback)
        } else {
          this.forwardSend(payload, callback)
        }
        return
      }

      default: {
        this.forwardSend(payload, callback)
        return
      }
    }
  }

  stop() {
    if (this.alreadyStopped) {
      return
    }
    try {
      stopProvider(this.existingProvider)
      this.alreadyStopped = true
    } catch (error) {
      debug(`Failed to close the connection: ${error}`)
    }
  }

  private async handleAccounts(_payload: JsonRpcPayload): Promise<any> {
    return this.getAccounts()
  }

  private async handleSignTypedData(payload: JsonRpcPayload): Promise<any> {
    const [address, typedData] = payload.params
    const signature = this.communication.wallet!.signTypedData(address, typedData)
    return signature
  }

  private async handleSignPersonalMessage(payload: JsonRpcPayload): Promise<any> {
    const address = payload.method === 'eth_sign' ? payload.params[0] : payload.params[1]
    const data = payload.method === 'eth_sign' ? payload.params[1] : payload.params[0]
    const ecSignatureHex = this.communication.wallet!.signPersonalMessage(address, data)
    return ecSignatureHex
  }

  private async handleSignTransaction(payload: JsonRpcPayload): Promise<EncodedTransaction> {
    const txParams = payload.params[0]
    const filledParams = await this.communication.paramsPopulator.populate(txParams)
    debugTxToSend('%O', filledParams)
    const signedTx = await this.communication.wallet!.signTransaction(filledParams)
    debugEncodedTx('%O', signedTx)
    return signedTx
  }

  private async handleSendTransaction(payload: JsonRpcPayload): Promise<any> {
    const signedTx = await this.handleSignTransaction(payload)
    const response = await this.communication.rpcCaller.call('eth_sendRawTransaction', [
      signedTx.raw,
    ])
    return response.result
  }

  private forwardSend(payload: JsonRpcPayload, callback: Callback<JsonRpcResponse>): void {
    this.communication.rpcCaller.send(payload, callback)
  }

  private checkPayloadWithAtLeastNParams(payload: JsonRpcPayload, n: number) {
    if (!payload.params || payload.params.length < n) {
      throw Error('Invalid params')
    }
  }

  // Functions required to act as a delefator for the existingProvider
  private addProviderDelegatedFunctions(): void {
    if (
      hasProperty<{ on: (type: string, callback: () => void) => void }>(this.existingProvider, 'on')
    ) {
      // @ts-ignore
      this.on = this.defaultOn
    }
    if (
      hasProperty<{ once: (type: string, callback: () => void) => void }>(
        this.existingProvider,
        'once'
      )
    ) {
      // @ts-ignore
      this.once = this.defaultOnce
    }
    if (
      hasProperty<{ removeListener: (type: string, callback: () => void) => void }>(
        this.existingProvider,
        'removeListener'
      )
    ) {
      // @ts-ignore
      this.removeListener = this.defaultRemoveListener
    }
    if (
      hasProperty<{ removeAllListener: (type: string, callback: () => void) => void }>(
        this.existingProvider,
        'removeAllListener'
      )
    ) {
      // @ts-ignore
      this.removeAllListener = this.defaultRemoveAllListeners
    }
    if (hasProperty<{ reset: () => void }>(this.existingProvider, 'reset')) {
      // @ts-ignore
      this.reset = this.defaultReset
    }
  }

  get connected() {
    return (this.existingProvider as any).connected
  }

  supportsSubscriptions() {
    return (this.existingProvider as any).supportsSubscriptions()
  }

  private defaultOn(type: string, callback: () => void): void {
    ;(this.existingProvider as any).on(type, callback)
  }

  private defaultOnce(type: string, callback: () => void): void {
    ;(this.existingProvider as any).once(type, callback)
  }

  private defaultRemoveListener(type: string, callback: () => void): void {
    ;(this.existingProvider as any).removeListener(type, callback)
  }

  private defaultRemoveAllListeners(type: string): void {
    ;(this.existingProvider as any).removeAllListeners(type)
  }

  private defaultReset(): void {
    ;(this.existingProvider as any).reset()
  }
}
