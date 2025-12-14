import { Context, Service } from 'koishi'
import { Config } from '..'
import { PresetTemplate } from 'koishi-plugin-chatluna/llm-core/prompt'
import { AIMessageChunk, SystemMessage } from '@langchain/core/messages'
import { parseRawModelName } from 'koishi-plugin-chatluna/llm-core/utils/count_tokens'
import {
    ChatLunaChatPrompt,
    ChatLunaChatPromptFormat
} from 'koishi-plugin-chatluna/llm-core/chain/prompt'
import {
    Runnable,
    RunnableConfig,
    RunnableLambda
} from '@langchain/core/runnables'
import {
    AgentExecutor,
    createOpenAIAgent
} from 'koishi-plugin-chatluna/llm-core/agent'
import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import {
    ChatLunaError,
    ChatLunaErrorCode
} from 'koishi-plugin-chatluna/utils/error'
import { computed, ComputedRef } from 'koishi-plugin-chatluna'
import { Embeddings } from '@langchain/core/embeddings'

export class ModelService extends Service {
    private _chains: Record<
        string,
        ComputedRef<
            [
                Runnable<
                    ChatLunaChatPromptFormat,
                    AIMessageChunk,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    RunnableConfig<Record<string, any>>
                >,
                ChatLunaChatModel
            ]
        >
    > = {}

    constructor(ctx: Context, config: Config) {
        super(ctx, 'chatluna_action_model')
    }

    async getChain(
        key: string,
        model: string,
        prompt: ComputedRef<PresetTemplate> | string,
        chatMode: 'chat' | 'plugin' = 'chat'
    ) {
        if (this._chains[key]) {
            return this._chains[key]
        }

        const currentPreset =
            typeof prompt === 'string'
                ? computed(
                      () =>
                          ({
                              triggerKeyword: [key],
                              rawText: prompt,
                              messages:
                                  prompt != null || prompt.trim().length > 0
                                      ? [new SystemMessage(prompt)]
                                      : [],
                              config: {}
                          }) satisfies PresetTemplate
                  )
                : prompt

        const llm = await this.ctx.chatluna.createChatModel(model)

        const embeddingsRef = await this._createEmbeddings()

        if (llm.value == null) {
            throw new ChatLunaError(ChatLunaErrorCode.MODEL_NOT_FOUND)
        }

        this._createChain(currentPreset, llm, embeddingsRef, key, chatMode)

        return this._chains[key]
    }

    private async _createChain(
        currentPreset: ComputedRef<PresetTemplate>,
        llmRef: ComputedRef<ChatLunaChatModel>,
        embeddingsRef: ComputedRef<Embeddings>,
        key: string,
        chatMode: 'chat' | 'plugin'
    ) {
        const chatPrompt = computed(() => {
            const llm = llmRef.value
            return new ChatLunaChatPrompt({
                preset: currentPreset,
                tokenCounter: (text) => llm.getNumTokens(text),
                sendTokenLimit:
                    llm.invocationParams().maxTokenLimit ??
                    llm.getModelMaxContextSize(),
                promptRenderService: this.ctx.chatluna.promptRenderer
            })
        })

        if (chatMode === 'plugin') {
            const toolsRef = this.ctx.chatluna.platform.getTools()

            const toolsComputed = computed(() =>
                toolsRef.value.map((tool) =>
                    this.ctx.chatluna.platform
                        .getTool(tool)
                        .createTool({ embeddings: embeddingsRef.value })
                )
            )

            const executorComputed = computed(() =>
                AgentExecutor.fromAgentAndTools({
                    tags: ['openai-functions'],
                    agent: createOpenAIAgent({
                        llm: llmRef.value,
                        tools: toolsComputed.value,
                        prompt: chatPrompt.value
                    }),
                    tools: toolsComputed.value,
                    memory: undefined,
                    verbose: false
                })
            )

            this._chains[key] = computed(() => {
                const executor = executorComputed.value
                return [
                    RunnableLambda.from(async (input) => {
                        const output = await executor.invoke(input)
                        return new AIMessageChunk({
                            content: output.output
                        })
                    }),
                    llmRef.value
                ]
            })
        } else {
            this._chains[key] = computed(() => [
                chatPrompt.value.pipe(llmRef.value),
                llmRef.value
            ])
        }
    }

    private async _createEmbeddings() {
        const [platform, modelName] = parseRawModelName(
            this.ctx.chatluna.config.defaultEmbeddings
        )

        return await this.ctx.chatluna.createEmbeddings(platform, modelName)
    }
}

declare module 'koishi' {
    interface Context {
        chatluna_action_model: ModelService
    }
}
