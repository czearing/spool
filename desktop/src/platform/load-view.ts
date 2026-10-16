export function loadView<T>(load: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("This view did not finish loading within 15 seconds.")), 15000);
    Promise.resolve().then(load).then(value => {
      clearTimeout(timer); resolve(value);
    }, error => { clearTimeout(timer); reject(error); });
  });
}
