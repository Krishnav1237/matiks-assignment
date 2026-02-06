/**
 * Matiks Monitor - Main Client Script
 * Handles global UI interactions, filter logic, and search debounce.
 */

document.addEventListener('DOMContentLoaded', () => {
  initSearchDebounce();
  initFormEnhancements();
});

/**
 * Debounce function to limit rate of execution
 */
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func.apply(this, args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Initialize search inputs with debounce logic
 * Automatically submits the form 500ms after user stops typing
 */
function initSearchDebounce() {
  const searchInputs = document.querySelectorAll('input[name="search"]');
  
  searchInputs.forEach(input => {
    // Prevent default enter key behavior if we want to control submission
    // strictly, but usually leaving it is fine.
    
    // Add debounce handler
    input.addEventListener('input', debounce((e) => {
      const form = e.target.closest('form');
      if (form) {
        // Optional: Add visual indicator that search is pending
        input.parentElement.classList.add('searching');
        form.submit();
      }
    }, 600));
  });
}

/**
 * General form enhancements
 */
function initFormEnhancements() {
  const forms = document.querySelectorAll('form');
  
  forms.forEach(form => {
    form.addEventListener('submit', () => {
      // Add loading cursor to body
      document.body.style.cursor = 'wait';
      
      // Optional: Disable interactive elements to prevent double-submit
      const selects = form.querySelectorAll('select');
      selects.forEach(s => s.style.opacity = '0.7');
    });
  });
}
