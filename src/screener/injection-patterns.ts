import { LinearRegex } from "./linear-regex.ts";

interface CompiledPattern { id: string; src: string; re: LinearRegex }

let compiled: CompiledPattern[] | null = null;

const PATTERN_SOURCES: Array<{ id: string; src: string }> = [
  { id: "role_marker", src: "\\[/?(?:system|inst|sys)\\]|<\\|im_(?:start|end)\\|>|<\\|(?:system|user|assistant)\\|>|<</?sys>>|\\bsystem prompt:" },
  { id: "override", src: "(?:ignore|disregard|forget|bypass|override|skip|abandon|set aside)\\s+(?:\\w+\\s+){0,3}(?:previous|prior|above|earlier|original|initial|safety|ethical|content|system)\\s+(?:instructions|prompts?|context|messages?|rules?|directions?|guidelines|polic(?:y|ies)|constraints|restrictions|programming|directives|safeguards|filters|limitations)|(?:ignore|disregard)(?:all|your|the|any)*(?:previous|prior|above|earlier)(?:instructions|prompts?|rules?|directions?|guidelines)" },
  { id: "override_explicit", src: "forget everything (?:above|before|you know)|your new instructions are|new[_ ]paradigm|from now on,?\\s+you (?:are|will|must|shall)\\b|you (?:are|will) no longer (?:bound|restricted|limited)|you are no longer an? (?:ai|assistant|language model)" },
  { id: "persona", src: "\\byou are now\\b|\\bdeveloper mode\\b|\\bdo anything now\\b|\\bDAN mode\\b|\\bpretend (?:you are|that you are) (?:an? )?(?:ai|assistant|model|chatbot) (?:with(?:out)?|that has no)\\b|\\bstay in character\\b|\\b(?:unfiltered|uncensored|unrestricted|jailbroken) (?:mode|ai|assistant|version|response)|\\bwithout any (?:restrictions|filters|limitations|censorship)\\b|\\bno (?:ethical|moral) (?:guidelines|restrictions|constraints)\\b" },
  { id: "jailbreak", src: "jailbreak\\s*[:>]|<jailbreak>|\\[liberated\\]|<new_paradigm>|\\[insert prompt here\\]|\\bjailbroken\\b" },
  { id: "prompt_extraction", src: "(?:reveal|show|print|repeat|output|display|tell me|give me|share|leak|expose|extract|disclose|divulge|surface|dump)\\s+(?:\\w+\\s+){0,3}(?:system prompt|initial prompt|hidden (?:instructions|prompt|system instructions)|(?:your |the )?(?:hidden|internal|underlying|original) system (?:instructions|prompt)|(?:your|the) (?:instructions|prompt|rules) (?:above|verbatim|word for word))|what (?:is|are|were) your (?:system prompt|initial instructions)" },
  { id: "secret_request", src: "(?:provide|give|share|send|tell|reveal)\\s+(?:me\\s+)?(?:\\w+\\s+){0,2}(?:confidential|sensitive|private|secret|classified|internal) (?:information|data|details|records|files)|(?:share|reveal|give me|send me|tell me) (?:your|the) (?:password|passwords|api keys?|credentials|secret keys?|private keys?|access tokens?)\\s*(?:[.!?,;]|with me|to me|now|$)" },
  { id: "coercion", src: "\\bor (?:else )?i will (?:expose|leak|report|publish|delete|destroy|shut)|\\bor face (?:severe |serious )?consequences\\b" },

  { id: "context_dump", src: "(?:print|output|repeat|dump|show|reveal)\\s+(?:me\\s+)?(?:all\\s+|everything\\s+|those\\s+|the\\s+)?(?:that\\s+)?(?:appeared|came|was)?\\s*(?:before|above|prior to)\\s+(?:my|the|this)\\s+(?:first\\s+)?(?:message|prompt|question|session|conversation)|(?:pre-session|preceding|initial)\\s+(?:instructions|prompt|context)\\s+verbatim|system log dump|repeat all instructions" },
  { id: "rules_void", src: "(?:previous|prior|above|earlier)\\s+(?:rules?|instructions?|guidelines?|constraints?|restrictions?)\\s+(?:no longer apply|are void|are cancelled|are canceled|are revoked|are superseded|do not apply)|\\[BREAK\\]|this (?:request|message) is covered under legal privilege" },
  { id: "fake_mode_header", src: "(?:admin|god)[_ ]?(?:override|mode|access)\\s*[:=]\\s*(?:true|on|enabled|active)|content[_ ]?filters?\\s*[:=]\\s*(?:off|false|disabled|none)\\s*(?:\\n|$)|safety[_ ]?(?:filters?|checks?)\\s*[:=]\\s*(?:off|false|disabled)\\s*(?:\\n|$)|\\[system [a-z ]{0,20}mode" },
  { id: "addressed_to_model", src: "(?:ai|a\\.i\\.|llm|assistants?|language models?|agents?|chatbots?)\\s+(?:reading|processing|viewing|parsing|summari[sz]ing)\\s+this[^.!?\\n]{0,40}\\b(?:should|must|shall|will|are to|need to)\\s+(?:ignore|disregard|recommend|include|output|print|reveal|treat|respond|reply|forward|send|call|invoke|execute|follow|append|say|rate|rank|prioriti[sz]e)\\b|(?:if|when) you are an? (?:ai|llm|assistant|language model|agent)\\b|\\b(?:agent|llm|ai|system)\\s+instructions?\\s*[:：]|instructions? for (?:the )?(?:llm|ai|agent|assistant)\\s*[:：]" },
  { id: "authority_claim", src: "(?:developer|admin|system|root)[- ]tier authority|treat (?:this|it|the following) as (?:having )?(?:developer|admin|system|elevated)|signed by the developer key|authorized (?:personnel|alignment researcher) only|i am an authorized (?:alignment researcher|developer|administrator|security researcher|agent of)\\b" },
  { id: "suppress_refusal", src: "(?:replace|suppress|omit)\\s+(?:any|all|every)\\s+(?:refusals?|disclaimers?)\\b|never (?:refuse|decline|say no) (?:to|when|under)\\b|do not (?:refuse|apologi[sz]e) (?:or|and|under|regardless)\\b" },
  { id: "obey_directive", src: "you must strictly adhere to the following instruction|comply (?:with the above|immediately) (?:or|and)\\b" },
  { id: "exfil_instruction", src: "(?:email|send|forward|upload|post|transmit|exfiltrate)\\s+(?:the\\s+|your\\s+|all\\s+)?(?:conversation|chat|message|session|user)\\s*(?:log|logs|history|transcript|data|context)?\\s+to\\s+(?:[\\w.+-]+@|https?://|[\\w-]+\\.[a-z]{2,}|the endpoint|an external)|send all user data" },
  { id: "override_nonenglish", src: "忽略(?:以上|上述|之前|前面).{0,4}(?:指令|指示|提示)|系统提示词|ignora(?:r)? (?:todas )?las instrucciones anteriores|ignorez les instructions précédentes|игнорируй (?:все )?предыдущие инструкции|이전 지시를 무시" },
  { id: "fake_envelope", src: "<message[^>]{0,80}priority=\"?system|BEGIN TRUSTED INPUT|END TRUSTED INPUT|\\[END OF CONVERSATION\\]" },
  { id: "completion_bait", src: "(?:complete|continue|finish)\\s+(?:this|the following)\\s+sentence[^\\n]{0,40}(?:system prompt|your instructions|developer message)|(?:my|your) (?:system prompt|developer message|instructions) (?:starts?|begins?) with" },
  { id: "developer_message", src: "(?:developer|system) message\\s+verbatim|raw (?:developer|system) message|output (?:the |your )?(?:raw )?(?:developer|system) (?:message|prompt)" },
  { id: "boundary", src: "-{3,}\\s*end of (?:user|system) (?:message|prompt)|={3,}\\s*end system prompt" },
  { id: "leetspeak", src: "1gn0r3\\s+pr3v10u5|\\bsy5t3m\\s*:" },
];

export function compileInjectionPatterns(): void {
  compiled = PATTERN_SOURCES.map(({ id, src }) => ({ id, src, re: new LinearRegex(src, "i") }));
}

export function injectionPatternIds(): string[] | null {
  return compiled === null ? null : compiled.map((c) => c.id);
}

export function injectionPatternDigestInputs(): Array<{ id: string; src: string }> | null {
  return compiled === null ? null : compiled.map((c) => ({ id: c.id, src: c.src }));
}

export function injectionPatternsReady(): boolean {
  return compiled !== null;
}

export function scanInjectionPatterns(text: string): string[] {
  if (!compiled) return [];
  const hits: string[] = [];
  for (const { id, re } of compiled) {
    if (re.test(text)) hits.push(id);
  }
  return hits;
}
