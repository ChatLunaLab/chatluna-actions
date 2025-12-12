import { Context, h } from 'koishi'
import { Config, logger } from '..'
import type {} from '../service/model'
import { getMessageContent } from 'koishi-plugin-chatluna/utils/string'
import {
    buildChainVariables,
    invokeChain,
    renderResult,
    resolvePreset,
    transformAndFormatMessage
} from '../utils'

export function apply(ctx: Context, config: Config) {
    const enabledCommands = config.commands.filter((command) => command.enabled)

    for (const command of enabledCommands) {
        ctx.command(
            command.command + ' <message:text>',
            command.description
        ).action(async ({ session }, message) => {
            if (
                command.model === null ||
                ctx.chatluna.platform.findModel(command.model).value == null
            ) {
                return '此命令没有选择模型，请联系管理员配置模型并重置。'
            }

            // --- 修改后的逻辑开始 ---

            // 即使 message 为空，也先解析（为了后续注入头像）
            // message 可能为 undefined，转为空字符串处理
            const elements = h.parse(message || '')
            
            // 辅助函数：生成QQ头像链接
            const getAvatarUrl = (id: string) => `http://q.qlogo.cn/headimg_dl?dst_uin=${id}&spec=640`

            const addedImages: h[] = []
            let atAvatarAdded = false

            // 处理 Feature 1: 艾特用户的头像
            if (command.useAtAvatar) {
                const atElements = elements.filter(e => e.type === 'at')
                if (atElements.length > 0) {
                    const atImages = atElements
                        .map(e => e.attrs.id)
                        .filter(id => id)
                        .map(id => h.image(getAvatarUrl(id)))
                    
                    if (atImages.length > 0) {
                        addedImages.push(...atImages)
                        atAvatarAdded = true
                    }
                }
            }

            // 处理 Feature 2: 用户自身头像逻辑
            const senderMode = command.senderAvatarMode || 'none'
            if (senderMode !== 'none') {
                const userId = session.userId
                if (userId) {
                    const senderImage = h.image(getAvatarUrl(userId))
                    
                    if (senderMode === 'always') {
                        // 始终传入
                        addedImages.push(senderImage)
                    } else if (senderMode === 'fallback') {
                        // 仅在没有艾特头像时传入
                        if (!atAvatarAdded) {
                            addedImages.push(senderImage)
                        }
                    }
                }
            }

            // 将新图片追加到 elements 中
            if (addedImages.length > 0) {
                elements.push(...addedImages)
                // 重新组合 message，此时如果注入了图片，message 将不再为空
                message = elements.join('')
            }

            // 现在进行空消息检查
            // 逻辑解释：
            // - 如果 message 本身为空且没注入图片 -> 为空
            // - 如果 message 本身为空但注入了图片 -> 不为空 (包含 <image ...>)
            // - 如果此时仍为空，检查引用回复或配置是否允许空消息执行
            if (
                ((message == null || message === '') && session.quote) ||
                command.allowExecuteWithoutMessage
            ) {
                message = message || '[ ]'
            }

            // 最终拦截：如果经过上述步骤 message 依然为空，则不执行
            if (!message) {
                return
            }

            // --- 修改后的逻辑结束 ---
  
            logger.debug(`Received command: ${command.command} ${message}`)

            const humanMessage = await transformAndFormatMessage(
                ctx,
                session,
                message,
                command.model,
                command.inputPrompt
            )

            const preset = resolvePreset(
                ctx,
                command.promptType,
                command.prompt,
                command.preset
            )

            const [chain, llm] = await ctx.chatluna_action_model
                .getChain(
                    command.command,
                    command.model,
                    preset,
                    command.chatMode
                )
                .then((ref) => ref.value)

            const variables = buildChainVariables(ctx, session)

            const result = await invokeChain(
                chain,
                llm,
                humanMessage,
                variables,
                session
            )

            if (
                typeof result.content === 'string' &&
                result.content.length < 30
            ) {
                logger.debug(`Command result: ${result.content}`)
            }

            return await renderResult(ctx, result.content)
        })
    }

    const enabledInterceptCommands = config.interceptCommands.filter(
        (command) => command.enabled
    )

    ctx.before('send', async (session, options) => {
        let scope: string = session.scope ?? options?.session?.['scope']

        if (scope == null) {
            return
        }

        // remove last
        scope = scope.split('.').slice(1, -1).join('.')
        const command = ctx.$commander.resolve(scope, session)

        if (!command) {
            return
        }

        const interceptCommand = enabledInterceptCommands.find(
            (interceptCommand) => interceptCommand.command === command.name
        )

        if (!interceptCommand) {
            return
        }

        if (
            interceptCommand.model === null ||
            ctx.chatluna.platform.findModel(interceptCommand.model) == null
        ) {
            return
        }

        const transformedMessage =
            await ctx.chatluna.messageTransformer.transform(
                session,
                session.elements,
                interceptCommand.model
            )

        const humanMessage = await transformAndFormatMessage(
            ctx,
            session,
            getMessageContent(transformedMessage.content),
            interceptCommand.model,
            interceptCommand.inputPrompt
        )

        const preset = resolvePreset(
            ctx,
            interceptCommand.promptType,
            interceptCommand.prompt,
            interceptCommand.preset
        )

        const [chain, llm] = await ctx.chatluna_action_model
            .getChain(
                interceptCommand.command,
                interceptCommand.model,
                preset,
                interceptCommand.chatMode
            )
            .then((ref) => ref.value)

        const variables = buildChainVariables(ctx, session)
        const result = await invokeChain(
            chain,
            llm,
            humanMessage,
            variables,
            session
        )

        logger.debug(`Command result: ${result.content}`)

        const llmResult = getMessageContent(result.content)

        // replace text to llm result

        let elements = session.elements

        let findTextElement = false
        for (const element of elements) {
            if (element.type === 'text') {
                element.attrs.content = llmResult
                element.attrs.x = 0
                findTextElement = true
                break
            }
        }

        if (!findTextElement) {
            elements.push(h('text', { content: llmResult }))
        } else {
            elements = elements.filter(
                (element) =>
                    element.type !== 'text' ||
                    (element.type === 'text' && element.attrs['x'] === 0)
            )
        }

        session.elements = elements
    })
}
