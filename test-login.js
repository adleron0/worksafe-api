const axios = require('axios');

const baseURL = 'http://localhost:3000'; // Ajuste a porta se necessário

async function testLogin() {
  console.log('=== Teste de Login ===\n');

  // Teste 1: Login com credenciais inválidas
  console.log('1. Testando login com credenciais inválidas...');
  try {
    const response = await axios.post(`${baseURL}/auth/login`, {
      email: 'usuario_invalido@exemplo.com',
      password: 'senha_errada',
      cnpj: '00.000.000/0000-00'
    });
    console.log('❌ ERRO: Login realizado com credenciais inválidas!');
    console.log('Response:', response.data);
  } catch (error) {
    if (error.response && error.response.status === 401) {
      console.log('✅ Sucesso: Login falhou corretamente com status 401');
      console.log('Mensagem:', error.response.data.message);
    } else {
      console.log('❌ ERRO inesperado:', error.message);
    }
  }

  console.log('\n2. Testando login com campos faltando...');
  try {
    const response = await axios.post(`${baseURL}/auth/login`, {
      email: 'usuario@exemplo.com'
      // password e cnpj ausentes
    });
    console.log('❌ ERRO: Login realizado sem todos os campos!');
    console.log('Response:', response.data);
  } catch (error) {
    if (error.response && error.response.status === 400) {
      console.log('✅ Sucesso: Validação funcionou corretamente');
      console.log('Erro de validação:', error.response.data.message);
    } else if (error.response && error.response.status === 401) {
      console.log('✅ Sucesso: Login falhou corretamente');
      console.log('Mensagem:', error.response.data.message);
    } else {
      console.log('❌ ERRO inesperado:', error.message);
    }
  }

  console.log('\n=== Teste concluído ===');
  console.log('\nPara testar com credenciais válidas, você precisa fornecer email, senha e CNPJ válidos do seu banco de dados.');
}

// Executar o teste
testLogin().catch(console.error);