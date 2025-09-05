export function getCertificateEmailTemplate(data: {
  companyName: string;
  logoUrl?: string;
  primaryColor?: string;
  secondaryColor?: string;
  traineeName: string;
  courseName?: string;
  certificateDate?: string;
  certificateUrl: string;
}): string {
  const primaryColor = data.primaryColor || '#4A90E2';
  const secondaryColor = data.secondaryColor || '#2C3E50';
  const companyName = data.companyName || 'Empresa';

  console.log('[TEMPLATE] Dados recebidos:', data);
  console.log('[TEMPLATE] Nome da empresa final:', companyName);

  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Certificado - ${data.companyName}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 0;
            background-color: #f4f4f4;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            box-shadow: 0 0 20px rgba(0, 0, 0, 0.1);
        }
        .header {
            background: ${primaryColor};
            padding: 40px 30px;
            text-align: center;
            border-radius: 0 0 20px 20px;
        }
        .header h1 {
            color: #ffffff;
            margin: 0;
            font-size: 28px;
            font-weight: 600;
            text-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }
        .content {
            padding: 40px 30px;
        }
        .greeting {
            color: ${secondaryColor};
            font-size: 20px;
            font-weight: 600;
            margin-bottom: 20px;
        }
        .message {
            color: #555;
            font-size: 16px;
            line-height: 1.8;
            margin-bottom: 30px;
        }
        .certificate-info {
            background: #f5f5f5;
            padding: 25px;
            border-radius: 15px;
            margin: 30px 0;
            border-left: 4px solid ${secondaryColor};
        }
        .certificate-info h2 {
            color: ${secondaryColor};
            margin: 0 0 15px 0;
            font-size: 18px;
            display: flex;
            align-items: center;
        }
        .certificate-info h2::before {
            content: "🎓";
            margin-right: 10px;
            font-size: 24px;
        }
        .info-item {
            color: #666;
            margin: 10px 0;
            font-size: 15px;
        }
        .info-item strong {
            color: ${secondaryColor};
            display: inline-block;
            min-width: 100px;
        }
        .cta-section {
            text-align: center;
            padding: 30px 0;
        }
        .cta-text {
            color: #666;
            margin-bottom: 20px;
            font-size: 16px;
        }
        .attachment-notice {
            background-color: #FFF3CD;
            border: 1px solid #FFC107;
            color: #856404;
            padding: 15px;
            border-radius: 10px;
            margin: 20px 0;
            text-align: center;
            font-size: 14px;
        }
        .attachment-notice::before {
            content: "📎";
            margin-right: 8px;
            font-size: 18px;
        }
        .footer {
            background-color: #f8f9fa;
            padding: 30px;
            text-align: center;
            border-top: 2px solid #e9ecef;
        }
        .footer-text {
            color: #999;
            font-size: 14px;
            margin: 10px 0;
        }
        .company-name {
            color: ${primaryColor};
            font-weight: 600;
        }
        .divider {
            height: 2px;
            background: linear-gradient(90deg, transparent, ${primaryColor}, transparent);
            margin: 30px 0;
        }
        .success-badge {
            display: inline-block;
            background: #4CAF50;
            color: white;
            padding: 6px 16px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: 600;
            margin: 20px 0;
            box-shadow: 0 2px 4px rgba(76, 175, 80, 0.2);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="company-header">
                <h2 style="color: #ffffff; margin: 0 0 10px 0; font-size: 18px; font-weight: 500; opacity: 0.9;">
                    ${companyName}
                </h2>
            </div>
            <h1>Certificado Disponível!</h1>
        </div>
        
        <div class="content">
            <div class="greeting">
                Olá, ${data.traineeName}! 👋
            </div>
            
            <div class="message">
                <p>Parabéns pela sua conquista! 🎉</p>
                <p>Temos o prazer de informar que seu certificado está pronto e disponível para visualização online.</p>
            </div>
            
            <div class="certificate-info">
                <h2>Informações do Certificado</h2>
                ${
                  data.courseName
                    ? `
                <div class="info-item">
                    <strong>Curso:</strong> ${data.courseName}
                </div>
                `
                    : ''
                }
                <div class="info-item">
                    <strong>Aluno:</strong> ${data.traineeName}
                </div>
                ${
                  data.certificateDate
                    ? `
                <div class="info-item">
                    <strong>Data:</strong> ${data.certificateDate}
                </div>
                `
                    : ''
                }
            </div>
            
            <div class="cta-button-container" style="text-align: center; margin: 30px 0;">
                <a href="${data.certificateUrl}" style="display: inline-block; background: ${primaryColor}; color: white; padding: 15px 40px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px; box-shadow: 0 3px 8px rgba(0, 0, 0, 0.15); transition: all 0.3s;">
                    🎓 Acessar Certificado Online
                </a>
            </div>
            
            <div class="url-info" style="background-color: #f8f9fa; padding: 15px; border-radius: 10px; margin: 20px 0; border-left: 3px solid ${secondaryColor};">
                <p style="margin: 0; color: #666; font-size: 14px;">
                    <strong>Link direto:</strong><br>
                    <a href="${data.certificateUrl}" style="color: ${primaryColor}; word-break: break-all;">
                        ${data.certificateUrl}
                    </a>
                </p>
            </div>
            
            <div class="divider"></div>
            
            <div class="cta-section">
                <p class="cta-text">
                    Este certificado é um reconhecimento do seu esforço e dedicação.
                </p>
                <span class="success-badge">✓ Certificado Oficial</span>
            </div>
            
            <div class="message">
                <p><strong>Importante:</strong></p>
                <ul style="color: #666; padding-left: 20px;">
                    <li>Acesse o link para visualizar e baixar seu certificado</li>
                    <li>Você pode imprimir o documento para seus registros</li>
                    <li>Este certificado é válido e pode ser verificado online</li>
                    <li>Guarde o link para acessar sempre que necessário</li>
                </ul>
            </div>
        </div>
        
        <div class="footer">
            <p class="footer-text">
                Este e-mail foi enviado automaticamente por <span class="company-name">${companyName}</span>
            </p>
            <p class="footer-text">
                © ${new Date().getFullYear()} ${companyName}. Todos os direitos reservados.
            </p>
        </div>
    </div>
</body>
</html>
  `;
}
