const PROXY_URL = '/api/assess'; // handled by Vercel serverless function (api/assess.js)

/* ================================================================
   VUE APPLICATION
================================================================ */
const { createApp, ref, computed, reactive } = Vue;

createApp({
  setup() {
    // ---- State ----
    const step        = ref('form');
    const error       = ref('');
    const result      = ref(null);
    const reasoning   = ref('');
    const typedReasoning = ref('');
    const isTyping    = ref(false);
    const showReasoning  = ref(false);
    const showObligations = ref(false);
    const stageIndex  = ref(0);
    const dots        = ref('.');

    const form = reactive({
      age:               '',
      residency:         'nz_citizen',
      relationship:      'single',
      dependents:        '0',
      employment:        '',
      healthDetails:     '',
      studying:          'no',
      income:            0,
      partnerIncome:     0,
      assets:            '',
      otherProperty:     'no',
      otherIncomeSources:[],
      other:             '',
    });

    // ---- Reference data ----
    const incomeSources = [
      'ACC payments', 'Child support received', 'Rental income',
      'Dividends / investments', 'Overseas pension', 'Boarder / flatmate payments',
      'Self-employment income', 'Other government payments',
    ];

    const stages = [
      'Verifying residency and citizenship status',
      'Checking employment situation and work test',
      'Calculating income abatement ($160 free zone)',
      'Checking study status',
      'Assessing assets and other circumstances',
      'Formulating decision and preparing receipt',
    ];

    // ---- Computed ----
    const isHealthSituation = computed(() =>
      form.employment === 'health_reduced' || form.employment === 'health_unable'
    );

    const baseRate = computed(() => {
      const age = parseInt(form.age) || 0;
      const hasDeps = parseInt(form.dependents) > 0;
      if (hasDeps) return 430;
      if (age < 25) return 348;
      return 372.55;
    });

    const decisionLabel = computed(() => {
      if (!result.value) return '';
      const d = result.value.decision;
      if (d === 'APPROVED') return 'Approved — eligible for Jobseeker Support';
      if (d === 'DECLINED') return 'Declined — not eligible at this time';
      return 'Further information needed';
    });

    const residencyLabel = computed(() => ({
      nz_citizen: 'NZ citizen',
      permanent_resident: 'Permanent resident',
      open_work_visa: 'Open work visa',
      student_visa: 'Student visa',
      visitor_visa: 'Visitor visa',
      none: 'No current status',
    }[form.residency] || form.residency));

    const relationshipLabel = computed(() => ({
      single: 'Single',
      partnered_both: 'Partnered — partner also seeking benefit',
      partnered_working: 'Partnered — partner is employed',
      separated: 'Separated or divorced',
      widowed: 'Widowed',
    }[form.relationship] || form.relationship));

    const employmentLabel = computed(() => ({
      unemployed_seeking:  'Unemployed, seeking work',
      redundant:           'Made redundant',
      resigned:            'Resigned',
      dismissed:           'Dismissed by employer',
      part_time_seeking:   'Part-time, seeking more hours',
      health_reduced:      'Health condition reduced hours',
      health_unable:       'Health condition — unable to work',
      self_employed_low:   'Self-employed, reduced income',
      employed_fulltime:   'Employed full-time',
    }[form.employment] || form.employment));

    const studyLabel = computed(() => ({
      no:               'Not studying',
      fulltime:         'Full-time study',
      parttime:         'Part-time study',
      approved_training:'Approved employment training',
    }[form.studying] || form.studying));

    // ---- Methods ----
    function toggleSource(src) {
      const idx = form.otherIncomeSources.indexOf(src);
      if (idx >= 0) form.otherIncomeSources.splice(idx, 1);
      else form.otherIncomeSources.push(src);
    }

    function buildPrompt() {
      return `JOBSEEKER SUPPORT APPLICATION
Date: ${new Date().toLocaleDateString('en-NZ', { dateStyle: 'long' })}

APPLICANT DETAILS:
- Age: ${form.age}
- Citizenship/residency: ${residencyLabel.value}
- Relationship status: ${relationshipLabel.value}
- Dependent children (under 18): ${form.dependents}

EMPLOYMENT SITUATION:
- Current situation: ${employmentLabel.value}${form.healthDetails ? '\n- Health condition detail: ' + form.healthDetails : ''}
- Study status: ${studyLabel.value}

INCOME (gross weekly, before tax):
- Applicant: $${form.income} NZD
${form.relationship.startsWith('partnered') ? '- Partner: $' + form.partnerIncome + ' NZD' : ''}
${form.otherIncomeSources.length > 0 ? '- Other declared income sources: ' + form.otherIncomeSources.join(', ') : '- No other income sources declared'}

ASSETS AND PROPERTY:
- Liquid savings and cash assets: $${form.assets} NZD
- Other property (beyond main home): ${form.otherProperty}

ADDITIONAL INFORMATION:
${form.other || 'None provided'}

Please assess Jobseeker Support eligibility with full transparent reasoning. Show all income calculations with actual numbers. Issue the decision in the required XML format.`.trim();
    }

    function validate() {
      if (!form.age || isNaN(parseInt(form.age))) {
        error.value = 'Please enter your age.';
        return false;
      }
      if (!form.employment) {
        error.value = 'Please select your current employment situation.';
        return false;
      }
      if (form.assets === '' || form.assets === null) {
        error.value = 'Please enter your liquid savings and assets (enter 0 if none).';
        return false;
      }
      if (isHealthSituation.value && !form.healthDetails.trim()) {
        error.value = 'Please briefly describe how the health condition affects your ability to work.';
        return false;
      }
      return true;
    }

    async function submit() {
      if (!validate()) return;
      error.value = '';

      step.value = 'processing';
      stageIndex.value = 0;
const stageTimer = setInterval(() => {
      stageIndex.value = Math.min(stageIndex.value + 1, stages.length - 1);
    }, 1800);

    const dotTimer = setInterval(() => {
      dots.value = dots.value.length >= 3 ? '.' : dots.value + '.';
    }, 500);

    try {
      const res = await fetch(PROXY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messages: [
            { role: 'user', content: buildPrompt() }
          ],
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `API Error Status (${res.status})`);
      }

      const data = await res.json();

      // ── Gemini-Native Property Capture ───────────────────────
      if (!data?.text) throw new Error('No generated response text returned from the assessment engine');
      
      const text = data.text;
      const get = tag => {
        const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
        return m ? m[1].trim() : '';
      };

      reasoning.value = get('reasoning');
      result.value = {
        decision: get('decision') || 'FURTHER_INFORMATION_NEEDED',
        rate: get('rate'),
        adjustedRate: get('adjusted_rate'),
        summary: get('summary'),
        obligations: get('obligations'),
        rights: get('rights'),
        timestamp: new Date().toLocaleString('en-NZ', { dateStyle: 'long', timeStyle: 'short' }),
        ref: 'WINZ-JS-' + Date.now().toString(36).toUpperCase().slice(-9),
      };

      step.value = 'result';
    } catch (e) {
      error.value = 'Assessment engine error: ' + e.message + '. Please check your configuration and try again.';
      step.value = 'form';
    } fileZone: {
      clearInterval(stageTimer);
      clearInterval(dotTimer);
    }
    }

    function toggleReasoning() {
      showReasoning.value = !showReasoning.value;
      if (showReasoning.value && typedReasoning.value.length === 0) {
        typeOut();
      }
    }

    function typeOut() {
      const text = reasoning.value;
      let i = 0;
      isTyping.value = true;
      typedReasoning.value = '';
      const id = setInterval(() => {
        if (i < text.length) {
          typedReasoning.value += text[i++];
          const box = document.querySelector('.reasoning-inner');
          if (box) box.scrollTop = box.scrollHeight;
        } else {
          clearInterval(id);
          isTyping.value = false;
        }
      }, 6);
    }

    function reset() {
      step.value = 'form';
      result.value = null;
      reasoning.value = '';
      typedReasoning.value = '';
      showReasoning.value = false;
      showObligations.value = false;
      error.value = '';
      document.getElementById('demo').scrollIntoView({ behavior: 'smooth' });
    }

    return {
      step, error, result, form, reasoning, typedReasoning, isTyping,
      showReasoning, showObligations, stageIndex, dots, stages,
      incomeSources, baseRate, decisionLabel,
      residencyLabel, relationshipLabel, employmentLabel, studyLabel,
      isHealthSituation,
      toggleSource, submit, toggleReasoning, reset,
    };
  },
}).mount('#demo-app');

/* ================================================================
   VANILLA JS — Nav scroll behaviour
================================================================ */
(function () {
  const sections = document.querySelectorAll('section[id]');
  const navLinks = document.querySelectorAll('.nav-links a[href^="#"]');

  function onScroll() {
    let current = '';
    sections.forEach(sec => {
      if (window.scrollY >= sec.offsetTop - 100) current = sec.id;
    });
    navLinks.forEach(a => {
      a.style.color = a.getAttribute('href') === '#' + current ? '#fff' : '';
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
})();
