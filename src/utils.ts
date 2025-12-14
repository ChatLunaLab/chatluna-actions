import { Context, h, Session } from 'koishi'
import {
    AIMessageChunk,
    HumanMessage,
    MessageContent
} from '@langchain/core/messages'
import { PromptTemplate } from '@langchain/core/prompts'
import {
    getCurrentWeekday,
    getMessageContent,
    getNotEmptyString
} from 'koishi-plugin-chatluna/utils/string'
import { Runnable, RunnableConfig } from '@langchain/core/runnables'
import { ChatLunaChatPromptFormat } from 'koishi-plugin-chatluna/llm-core/chain/prompt'
import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { randomUUID } from 'crypto'

export interface MessageTransformOptions {
    useAtAvatar?: boolean
    senderAvatarMode?: 'none' | 'fallback' | 'always'
}

async function createAvatarImage(
    session: Session,
    userId: string
): Promise<h | null> {
    if (!userId) {
        return null
    }

    try {
        const user = await session.bot?.getUser?.(userId, session.guildId)
        const avatarUrl = user?.avatar ?? getAvatarUrl(userId)
        return h.image(avatarUrl)
    } catch {
        return h.image(getAvatarUrl(userId))
    }
}

// Append mention and sender avatars when requested in options.
async function appendAvatarImages(
    elements: h[],
    session: Session,
    options?: MessageTransformOptions
): Promise<void> {
    if (!options) {
        return
    }

    const addedImages: h[] = []
    let atAvatarAdded = false

    if (options.useAtAvatar) {
        const atIds = elements
            .filter((element) => element.type === 'at')
            .map((element) => element.attrs?.id)
            .filter((id): id is string => Boolean(id))

        if (atIds.length > 0) {
            const atImages = (
                await Promise.all(
                    atIds.map((id) => createAvatarImage(session, id))
                )
            ).filter((image): image is h => Boolean(image))

            if (atImages.length > 0) {
                addedImages.push(...atImages)
                atAvatarAdded = true
            }
        }
    }

    const senderMode = options.senderAvatarMode ?? 'none'
    if (senderMode !== 'none') {
        const userId = session.userId
        if (userId) {
            const senderImage = await createAvatarImage(session, userId)
            if (senderImage) {
                if (senderMode === 'always') {
                    addedImages.push(senderImage)
                } else if (senderMode === 'fallback' && !atAvatarAdded) {
                    addedImages.push(senderImage)
                }
            }
        }
    }

    if (addedImages.length === 0) {
        return
    }

    let lastImageIndex = -1
    for (let i = elements.length - 1; i >= 0; i--) {
        if (elements[i].type === 'image') {
            lastImageIndex = i
            break
        }
    }

    if (lastImageIndex >= 0) {
        elements.splice(lastImageIndex + 1, 0, ...addedImages)
    } else {
        elements.push(...addedImages)
    }
}

export interface TransformResult {
    humanMessage: HumanMessage
    message: string
}

export async function transformAndFormatMessage(
    ctx: Context,
    session: Session,
    message: string | undefined,
    modelName: string,
    inputPromptTemplate: string,
    options?: MessageTransformOptions
): Promise<TransformResult> {
    const parsedInput = message || ''
    const elements = h.parse(parsedInput)
    await appendAvatarImages(elements, session, options)
    const normalizedMessage = elements.join('')

    const transformedMessage = await ctx.chatluna.messageTransformer.transform(
        session,
        elements,
        modelName
    )

    const inputPrompt = PromptTemplate.fromTemplate(
        inputPromptTemplate ?? '{input}'
    )
    const formattedInputPrompt = await inputPrompt.format({
        input: getMessageContent(transformedMessage.content)
    })

    const finalMessageContent =
        typeof transformedMessage.content === 'string'
            ? formattedInputPrompt
            : transformedMessage.content.map((part) => {
                  if (part.type !== 'text') return part
                  part.text = formattedInputPrompt
                  return part
              })

    return {
        humanMessage: new HumanMessage({
            content: finalMessageContent,
            name: transformedMessage.name,
            id: session.userId,
            additional_kwargs: { ...transformedMessage.additional_kwargs }
        }),
        message: normalizedMessage
    }
}

export function buildChainVariables(ctx: Context, session: Session) {
    const chatLunaConfig = ctx.chatluna.config
    return {
        name: chatLunaConfig.botNames[0],
        date: new Date().toLocaleString(),
        bot_id: session.bot.selfId,
        is_group: (!session.isDirect || session.guildId != null).toString(),
        is_private: session.isDirect?.toString(),
        user_id: session.author?.user?.id ?? session.event?.user?.id ?? '0',
        user: getNotEmptyString(
            session.author?.nick,
            session.author?.name,
            session.event.user?.name,
            session.username
        ),
        built: {
            preset: 'x',
            conversationId: session.guildId
        },
        noop: '',
        time: new Date().toLocaleTimeString(),
        weekday: getCurrentWeekday()
    }
}

export const getAvatarUrl = (id: string) =>
    `http://q.qlogo.cn/headimg_dl?dst_uin=${id}&spec=640`

export async function invokeChain(
    chain: Runnable<
        ChatLunaChatPromptFormat,
        AIMessageChunk,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        RunnableConfig<Record<string, any>>
    >,
    llm: ChatLunaChatModel,
    humanMessage: HumanMessage,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    variables: Record<string, any>,
    session: Session
) {
    return await chain.invoke(
        {
            input: humanMessage,
            chat_history: [],
            variables
        },
        {
            metadata: {
                session,
                model: llm,
                userId: session.userId,
                conversationId: session.guildId
            }
        }
    )
}

export function resolvePreset(
    ctx: Context,
    promptType: string,
    prompt: string,
    preset: string
) {
    return promptType === 'instruction'
        ? prompt
        : ctx.chatluna.preset.getPreset(preset)
}

export async function renderResult(ctx: Context, content: MessageContent) {
    const mdRenderer = await ctx.chatluna.renderer.getRenderer('text')
    return await mdRenderer
        .render({ content }, { type: 'text' })
        .then((rendered) => rendered.element)
}

export function normalizeCommandName(name: string): string {
    // Common Chinese to English mapping for command names
    const chineseToEnglish: Record<string, string> = {
        // Common command terms
        帮助: 'help',
        列表: 'list',
        查询: 'query',
        搜索: 'search',
        添加: 'add',
        删除: 'delete',
        修改: 'modify',
        更新: 'update',
        获取: 'get',
        设置: 'set',
        创建: 'create',
        移除: 'remove',
        显示: 'show',
        查看: 'view',
        编辑: 'edit',
        保存: 'save',
        加载: 'load',
        启动: 'start',
        停止: 'stop',
        重启: 'restart',
        状态: 'status',
        信息: 'info',
        配置: 'config',
        管理: 'manage',
        用户: 'user',
        消息: 'message',
        发送: 'send',
        接收: 'receive',
        清除: 'clear',
        重置: 'reset',
        导入: 'import',
        导出: 'export',
        测试: 'test',
        运行: 'run',
        执行: 'execute',
        调用: 'call',
        刷新: 'refresh',
        同步: 'sync',
        连接: 'connect',
        断开: 'disconnect',
        登录: 'login',
        登出: 'logout',
        注册: 'register',
        验证: 'verify',
        授权: 'authorize',
        禁用: 'disable',
        启用: 'enable',
        切换: 'toggle',
        复制: 'copy',
        粘贴: 'paste',
        剪切: 'cut',
        撤销: 'undo',
        重做: 'redo',
        分享: 'share',
        上传: 'upload',
        下载: 'download',
        安装: 'install',
        卸载: 'uninstall',
        备份: 'backup',
        恢复: 'restore',
        统计: 'stats',
        分析: 'analyze',
        报告: 'report',
        通知: 'notify',
        提醒: 'remind',
        订阅: 'subscribe',
        取消: 'cancel',
        确认: 'confirm',
        拒绝: 'reject',
        接受: 'accept',
        批准: 'approve',
        审核: 'review',
        检查: 'check',
        扫描: 'scan',
        过滤: 'filter',
        排序: 'sort',
        分组: 'group',
        合并: 'merge',
        拆分: 'split',
        转换: 'convert',
        翻译: 'translate',
        计算: 'calculate',
        比较: 'compare',
        匹配: 'match',
        替换: 'replace',
        插入: 'insert',
        追加: 'append',
        前置: 'prepend',
        打开: 'open',
        关闭: 'close',
        锁定: 'lock',
        解锁: 'unlock',
        隐藏: 'hide',
        展开: 'expand',
        折叠: 'collapse',
        最小化: 'minimize',
        最大化: 'maximize',
        全屏: 'fullscreen',
        退出: 'exit',
        返回: 'back',
        前进: 'forward',
        跳转: 'jump',
        导航: 'navigate',
        定位: 'locate',
        标记: 'mark',
        高亮: 'highlight',
        选择: 'select',
        取消选择: 'deselect',
        全选: 'selectall',
        反选: 'invert',
        预览: 'preview',
        打印: 'print',
        格式化: 'format',
        美化: 'beautify',
        压缩: 'compress',
        解压: 'decompress',
        加密: 'encrypt',
        解密: 'decrypt',
        签名: 'sign',
        验签: 'verifysign',
        哈希: 'hash',
        编码: 'encode',
        解码: 'decode',
        解析: 'parse',
        生成: 'generate',
        构建: 'build',
        编译: 'compile',
        部署: 'deploy',
        发布: 'publish',
        回滚: 'rollback',
        监控: 'monitor',
        调试: 'debug',
        日志: 'log',
        记录: 'record',
        追踪: 'trace',
        性能: 'performance',
        优化: 'optimize',
        清理: 'clean',
        维护: 'maintain',
        修复: 'fix',
        诊断: 'diagnose',
        健康: 'health',
        版本: 'version',
        关于: 'about',
        许可: 'license',
        文档: 'doc',
        示例: 'example',
        教程: 'tutorial',
        指南: 'guide',
        参考: 'reference',
        索引: 'index',
        目录: 'catalog',
        分类: 'category',
        标签: 'tag',
        评论: 'comment',
        回复: 'reply',
        点赞: 'like',
        收藏: 'favorite',
        关注: 'follow',
        推荐: 'recommend',
        排行: 'rank',
        热门: 'hot',
        最新: 'latest',
        随机: 'random'
    }

    let result = name

    // Replace Chinese characters with English equivalents
    for (const [chinese, english] of Object.entries(chineseToEnglish)) {
        result = result.replace(new RegExp(chinese, 'g'), english)
    }

    // Remove all non-alphanumeric characters except dots (for command hierarchy)
    result = result.replace(/[^a-zA-Z0-9.]/g, '')

    // If the result is empty or starts with a number, add a prefix
    if (result.length === 0 || /^[0-9]/.test(result)) {
        result =
            'cmd' +
            (result ||
                randomUUID()
                    .substring(0, 12)
                    .replace(/[^a-zA-Z0-9]/g, ''))
    }

    return result
}
