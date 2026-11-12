// `fabric/node` é exposto só via "exports" do pacote, que o moduleResolution
// node10 do tsconfig não lê. Mesmos tipos do build de navegador.
declare module 'fabric/node' {
  export * from 'fabric';
}
