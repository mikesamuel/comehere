export let x =
  Math.random() >= 0.5
  ? (() => {
      COMEHERE:with('In ? of hook') {
        console.log('in ?');
      }
      return 1;
    })()
  : 0;
