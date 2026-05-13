const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-3.5-turbo'
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-pro'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = req.body || {}
  const provider = (body.provider || 'openai').toString().trim().toLowerCase()
  const prompt = (body.prompt || '').toString().trim()

  if (!prompt) {
    res.status(400).json({ error: 'Prompt is required' })
    return
  }

  try {
    if (provider === 'gemini') {
      const apiKey = process.env.GEMINI_API_KEY
      if (!apiKey) {
        res.status(500).json({ error: 'Server missing Gemini API key' })
        return
      }

      const response = await fetch(`https://gemini.googleapis.com/v1/models/${GEMINI_MODEL}:generateMessage?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            {
              author: 'user',
              content: [
                {
                  type: 'text',
                  text: prompt,
                },
              ],
            },
          ],
          temperature: 0.7,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => null)
        throw new Error(errorData?.error || 'Gemini request failed')
      }

      const data = await response.json()
      const candidate = data?.candidates?.[0]
      const outputText = candidate?.content?.find((item) => item.type === 'output_text')?.text || candidate?.content?.[0]?.text || ''
      res.status(200).json({ text: outputText || '' })
      return
    }

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      res.status(500).json({ error: 'Server missing OpenAI API key' })
      return
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: 'You are an intraday equity trader who provides a short daily plan and a watch list of names or signals.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 400,
        temperature: 0.7,
      }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => null)
      throw new Error(errorData?.error?.message || 'OpenAI request failed')
    }

    const data = await response.json()
    const aiText = data?.choices?.[0]?.message?.content?.trim() || ''
    res.status(200).json({ text: aiText })
  } catch (error) {
    console.error('AI proxy error:', error)
    res.status(500).json({ error: error.message || 'AI proxy request failed' })
  }
}
