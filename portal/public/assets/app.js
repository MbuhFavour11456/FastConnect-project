const plans = {
  '10': { name: '10-day plan', price: '2,000 XAF' },
  '30': { name: '30-day plan', price: '5,000 XAF' },
};

const selectedPlan = plans[new URLSearchParams(window.location.search).get('plan')];

if (selectedPlan) {
  document.querySelector('#plan-name').textContent = selectedPlan.name;
  document.querySelector('#plan-price').textContent = selectedPlan.price;
}

document.querySelectorAll('[data-network]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-network]').forEach((option) => {
      const isSelected = option === button;
      option.classList.toggle('selected', isSelected);
      option.setAttribute('aria-pressed', String(isSelected));
    });
  });
});
